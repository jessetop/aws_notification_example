<?php
// Permit lookup. Produces real PHP fatal errors on bad input:
//   ?id=12   -> 200 JSON
//   ?id=abc  -> uncaught TypeError (strict types), HTTP 500
//   ?id=db   -> uncaught PDOException (no database runs on this host), HTTP 500
declare(strict_types=1);

final class PermitService
{
    public function find(int $id): array
    {
        return ['id' => $id, 'status' => 'approved'];
    }
}

header('Content-Type: application/json');
$id = $_GET['id'] ?? '1';

if ($id === 'db') {
    $pdo = new PDO('mysql:host=127.0.0.1;port=3306;dbname=permits', 'permits_app', 'demo', [PDO::ATTR_TIMEOUT => 2]);
}

// Numeric strings are converted; anything else is passed through and fails the int type check.
echo json_encode((new PermitService())->find(ctype_digit($id) ? (int) $id : $id));
