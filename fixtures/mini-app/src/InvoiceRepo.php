<?php
require_once __DIR__ . '/Config.php';

// T1: data access with raw SQL and no DTOs. Rows are plain assoc arrays.
class InvoiceRepo
{
    private PDO $pdo;

    public function __construct(?PDO $pdo = null)
    {
        $this->pdo = $pdo ?? new PDO(Config::dsn());
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, customer TEXT, customer_type TEXT, lines TEXT, created_at TEXT)');
    }

    public function find(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM invoices WHERE id = ?');
        $st->execute([$id]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $row['lines'] = json_decode($row['lines'], true) ?: [];
        return $row;
    }

    public function save(array $invoice): int
    {
        $st = $this->pdo->prepare('INSERT INTO invoices (customer, customer_type, lines, created_at) VALUES (?, ?, ?, ?)');
        $st->execute([
            $invoice['customer'] ?? '',
            $invoice['customer_type'] ?? 'regular',
            json_encode($invoice['lines'] ?? []),
            date('c'),
        ]);
        return (int) $this->pdo->lastInsertId();
    }

    public function listRecent(int $limit = 20): array
    {
        $st = $this->pdo->query('SELECT id, customer, created_at FROM invoices ORDER BY id DESC LIMIT ' . (int) $limit);
        return $st->fetchAll(PDO::FETCH_ASSOC);
    }
}
