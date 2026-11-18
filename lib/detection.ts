/**
 * Phase 2: EC2 hosts producing REAL logs, shipped by the CloudWatch Agent into
 * the fleet log groups (one group per log type, one stream per host).
 *   - Ubuntu: Apache + PHP demo app (+ traffic generator) → apache-access, php-error
 *   - Windows: Event Logs (Application, System, Security) → windows-*
 * Alerting is done by the rules engine (lib/log-analytics.ts), not per-host alarms.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { HOSTS, LOG_GROUP_PREFIX, type LogType } from './config';

const EC2_DIR = path.join(__dirname, '..', 'ec2');
const UBUNTU_AMI_PARAM = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';

const UBUNTU_LOG_TYPES: LogType[] = ['php-error', 'apache-access'];
const WINDOWS_LOG_TYPES: LogType[] = ['windows-application', 'windows-system', 'windows-security'];

/** Windows Security events worth shipping (failed logon, lockout, account created, group change, log cleared). */
const SECURITY_EVENT_IDS = [4625, 4740, 4720, 4732, 1102];

export interface DetectionProps {
  vpc: ec2.IVpc;
  groups: Record<LogType, logs.ILogGroup>;
}

export interface HostResources {
  id: string;
  instance: ec2.Instance;
}

const read = (...p: string[]) => fs.readFileSync(path.join(EC2_DIR, ...p), 'utf8').replace(/\r\n/g, '\n');
const group = (t: LogType) => `${LOG_GROUP_PREFIX}${t}`;

function ubuntuAgentConfig(hostId: string): string {
  return JSON.stringify(
    {
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: '/var/log/php/error.log',
                log_group_name: group('php-error'),
                log_stream_name: hostId,
                // Fatal errors include a multi-line stack trace; keep each error as one event.
                multi_line_start_pattern: '^\\[\\d{2}-[A-Za-z]{3}-\\d{4}',
              },
              { file_path: '/var/log/apache2/access.log', log_group_name: group('apache-access'), log_stream_name: hostId },
            ],
          },
        },
      },
    },
    null,
    2,
  );
}

function windowsAgentConfig(hostId: string): string {
  const problemLevels = ['WARNING', 'ERROR', 'CRITICAL'];
  return JSON.stringify(
    {
      logs: {
        logs_collected: {
          windows_events: {
            collect_list: [
              { event_name: 'Application', event_levels: problemLevels, log_group_name: group('windows-application'), log_stream_name: hostId, event_format: 'text' },
              { event_name: 'System', event_levels: problemLevels, log_group_name: group('windows-system'), log_stream_name: hostId, event_format: 'text' },
              {
                event_name: 'Security',
                // Audit events are logged at level 0 ("LogAlways"), so include every level and filter by event ID.
                event_levels: ['INFORMATION', 'WARNING', 'ERROR', 'CRITICAL', 'VERBOSE'],
                event_ids: SECURITY_EVENT_IDS,
                log_group_name: group('windows-security'),
                log_stream_name: hostId,
                event_format: 'text',
              },
            ],
          },
        },
      },
    },
    null,
    2,
  );
}

function heredoc(target: string, content: string, tag: string): string[] {
  return [`cat > ${target} <<'${tag}'`, content.replace(/\n$/, ''), tag];
}

function ubuntuUserData(hostId: string): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  const phpIni = [
    'log_errors = On',
    'display_errors = Off',
    'error_reporting = E_ALL',
    'error_log = /var/log/php/error.log',
    'zend.exception_ignore_args = On',
  ].join('\n');
  ud.addCommands(
    'set -euxo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    'apt-get install -y apache2 libapache2-mod-php php-mysql curl',
    // PHP errors go to their own file, which the agent ships as php-error.
    'install -d -o www-data -g www-data -m 0755 /var/log/php',
    'install -o www-data -g www-data -m 0644 /dev/null /var/log/php/error.log',
    ...heredoc('/tmp/99-notification-demo.ini', phpIni, 'INI_EOF'),
    'for d in /etc/php/*/apache2/conf.d; do cp /tmp/99-notification-demo.ini "$d/"; done',
    'rm -f /var/www/html/index.html',
    ...['index.php', 'permits.php', 'login.php', 'report.php'].flatMap((f) =>
      heredoc(`/var/www/html/${f}`, read('ubuntu', 'app', f), 'PHP_EOF'),
    ),
    'systemctl restart apache2',
    'mkdir -p /opt/notification-demo',
    ...heredoc('/opt/notification-demo/traffic.sh', read('ubuntu', 'traffic.sh'), 'TRAFFIC_EOF'),
    'chmod +x /opt/notification-demo/traffic.sh',
    'curl -fsSL --retry 5 -o /tmp/cwagent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb',
    'dpkg -i -E /tmp/cwagent.deb',
    ...heredoc('/opt/aws/amazon-cloudwatch-agent/etc/notification-demo.json', ubuntuAgentConfig(hostId), 'CWAGENT_EOF'),
    '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/notification-demo.json',
    ...heredoc(
      '/etc/systemd/system/notification-traffic.service',
      [
        '[Unit]',
        'Description=Notification demo traffic generator (drives the PHP app)',
        'After=network-online.target apache2.service',
        '[Service]',
        'ExecStart=/opt/notification-demo/traffic.sh',
        'Restart=always',
        'RestartSec=5',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n'),
      'UNIT_EOF',
    ),
    'systemctl daemon-reload',
    'systemctl enable --now notification-traffic.service',
  );
  return ud;
}

function windowsUserData(hostId: string): ec2.UserData {
  const ud = ec2.UserData.forWindows();
  ud.addCommands(
    "$ErrorActionPreference = 'Stop'",
    "New-Item -ItemType Directory -Force -Path 'C:\\NotificationDemo', 'C:\\ProgramData\\NotificationDemo' | Out-Null",
    // Make sure failed logons are audited (4625), regardless of the AMI's default policy.
    'auditpol /set /subcategory:"Logon" /success:enable /failure:enable',
    "$generator = @'",
    read('windows', 'generator.ps1').replace(/\n$/, ''),
    "'@",
    "Set-Content -Path 'C:\\NotificationDemo\\generator.ps1' -Value $generator -Encoding UTF8",
    "$msi = Join-Path $env:TEMP 'amazon-cloudwatch-agent.msi'",
    "Invoke-WebRequest -UseBasicParsing -Uri 'https://amazoncloudwatch-agent.s3.amazonaws.com/windows/amd64/latest/amazon-cloudwatch-agent.msi' -OutFile $msi",
    "Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn' -Wait",
    "$cfg = @'",
    windowsAgentConfig(hostId),
    "'@",
    "Set-Content -Path 'C:\\ProgramData\\NotificationDemo\\cwagent.json' -Value $cfg -Encoding ASCII",
    "& 'C:\\Program Files\\Amazon\\AmazonCloudWatchAgent\\amazon-cloudwatch-agent-ctl.ps1' -a fetch-config -m ec2 -s -c 'file:C:\\ProgramData\\NotificationDemo\\cwagent.json'",
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\\NotificationDemo\\generator.ps1'",
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)',
    "Register-ScheduledTask -TaskName 'NotificationGenerator' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force",
    "Start-ScheduledTask -TaskName 'NotificationGenerator'",
  );
  return ud;
}

export class Detection extends Construct {
  readonly hosts: HostResources[] = [];

  constructor(scope: Construct, id: string, props: DetectionProps) {
    super(scope, id);

    // Zero inbound rules: access is SSM Session Manager only.
    const sg = new ec2.SecurityGroup(this, 'HostSg', {
      vpc: props.vpc,
      description: 'Notification demo hosts: no inbound, all outbound',
      allowAllOutbound: true,
    });

    for (const host of HOSTS) {
      const isWindows = host.os === 'windows';
      const role = new iam.Role(this, `Role-${host.id}`, {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      });
      for (const t of isWindows ? WINDOWS_LOG_TYPES : UBUNTU_LOG_TYPES) {
        props.groups[t].grantWrite(role);
        role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogStreams'], resources: [props.groups[t].logGroupArn] }));
      }

      const instance = new ec2.Instance(this, `Host-${host.id}`, {
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        associatePublicIpAddress: true,
        securityGroup: sg,
        role,
        requireImdsv2: true,
        propagateTagsToVolumeOnCreation: true, // EBS cost shows up under the Project tag
        instanceType: new ec2.InstanceType(isWindows ? 't3.medium' : 't3.small'),
        machineImage: isWindows
          ? ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE)
          : ec2.MachineImage.fromSsmParameter(UBUNTU_AMI_PARAM, { os: ec2.OperatingSystemType.LINUX }),
        userData: isWindows ? windowsUserData(host.id) : ubuntuUserData(host.id),
        // User data only runs on first boot, so a changed script must mean a new instance.
        userDataCausesReplacement: true,
        blockDevices: [
          {
            deviceName: '/dev/sda1', // root device for both the Ubuntu and Windows AMIs
            volume: ec2.BlockDeviceVolume.ebs(isWindows ? 30 : 10, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }),
          },
        ],
      });
      for (const t of isWindows ? WINDOWS_LOG_TYPES : UBUNTU_LOG_TYPES) instance.node.addDependency(props.groups[t]);
      this.hosts.push({ id: host.id, instance });
    }
  }
}
