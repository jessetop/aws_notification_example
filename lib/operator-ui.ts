/** Phase 6: S3 static site (operator UI + public notices), HTTP API (alerts, rules, fleet logs), operator key. */
import * as path from 'node:path';
import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { LOG_GROUP_PREFIX, PROJECT } from './config';
import { makeFunction } from './workflow';

export interface OperatorUiProps {
  siteBucket: s3.Bucket;
  notificationsTable: dynamodb.ITable;
  configTable: dynamodb.ITable;
}

/** Public-read website bucket. Created separately because the workflow writes notices into it. */
export function createSiteBucket(scope: Construct): s3.Bucket {
  return new s3.Bucket(scope, 'SiteBucket', {
    websiteIndexDocument: 'index.html',
    publicReadAccess: true,
    blockPublicAccess: new s3.BlockPublicAccess({
      blockPublicAcls: true,
      ignorePublicAcls: true,
      blockPublicPolicy: false,
      restrictPublicBuckets: false,
    }),
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });
}

export class OperatorUi extends Construct {
  readonly api: apigw.HttpApi;
  readonly operatorKey: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: OperatorUiProps) {
    super(scope, id);

    this.operatorKey = new secretsmanager.Secret(this, 'OperatorKey', {
      secretName: `${PROJECT}/operator-key`,
      description: 'Shared key the operator UI sends as x-operator-key',
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const apiFn = makeFunction(this, 'Api', 'api.ts', {
      env: {
        NOTIFICATIONS_TABLE: props.notificationsTable.tableName,
        CONFIG_TABLE: props.configTable.tableName,
        OPERATOR_KEY_SECRET_ARN: this.operatorKey.secretArn,
        LOG_GROUP_PREFIX,
      },
    });
    const { region, account } = Stack.of(this);
    const fleetGroups = `arn:aws:logs:${region}:${account}:log-group:${LOG_GROUP_PREFIX}*`;
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['logs:StartQuery', 'logs:DescribeLogStreams'], resources: [fleetGroups] }),
    );
    // Query IDs are not resources; GetQueryResults/StopQuery only accept "*".
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }));
    this.operatorKey.grantRead(apiFn);
    props.configTable.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${props.notificationsTable.tableArn}/index/RecentIndex`],
      }),
    );

    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${PROJECT}-operator-api`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [props.siteBucket.bucketWebsiteUrl],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'x-operator-key'],
      },
    });
    // Not 'Default': CDK treats a child with that id as the parent's own resource (logical-id clash).
    this.api.addStage('ThrottledStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const routes: Array<[apigw.HttpMethod, string]> = [
      [apigw.HttpMethod.GET, '/health'],
      [apigw.HttpMethod.GET, '/channels'],
      [apigw.HttpMethod.PUT, '/channels/{name}'],
      [apigw.HttpMethod.PUT, '/settings/dedup'],
      [apigw.HttpMethod.GET, '/history'],
      [apigw.HttpMethod.GET, '/rules'],
      [apigw.HttpMethod.PUT, '/rules/{id}'],
      [apigw.HttpMethod.DELETE, '/rules/{id}'],
      [apigw.HttpMethod.GET, '/logs/hosts'],
      [apigw.HttpMethod.POST, '/logs/query'],
      [apigw.HttpMethod.GET, '/logs/query/{id}'],
    ];
    for (const [method, routePath] of routes) this.api.addRoutes({ path: routePath, methods: [method], integration });

    new s3deploy.BucketDeployment(this, 'DeployUi', {
      destinationBucket: props.siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'ui')),
        s3deploy.Source.jsonData('config.json', { apiUrl: this.api.apiEndpoint }),
      ],
      prune: false, // keep notices/ written by the workflow
      cacheControl: [s3deploy.CacheControl.noCache()],
    });
  }
}
