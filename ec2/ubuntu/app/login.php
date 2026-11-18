<?php
// Staff sign-in. In this demo every attempt fails: logs a WARN line to the PHP
// error log and returns HTTP 401 (which also shows up in the Apache access log).
declare(strict_types=1);

$user = substr((string) preg_replace('/[^A-Za-z0-9_.-]/', '', (string) ($_POST['user'] ?? '')), 0, 32);
$ip = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '-');
$ip = (string) preg_replace('/[^0-9a-fA-F.:]/', '', $ip);

error_log(sprintf('WARN [auth] Failed login for user "%s" from %s', $user, $ip));
http_response_code(401);
header('Content-Type: text/plain');
echo 'Invalid credentials';
