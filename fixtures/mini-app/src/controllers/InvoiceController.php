<?php
require_once __DIR__ . '/../Pricing.php';
require_once __DIR__ . '/../InvoiceRepo.php';

// T2: HTTP handlers. Reads superglobals directly, renders a template, no DTOs.
class InvoiceController
{
    private InvoiceRepo $repo;

    public function __construct(?InvoiceRepo $repo = null)
    {
        $this->repo = $repo ?? new InvoiceRepo();
    }

    public function show(int $id): string
    {
        $invoice = $this->repo->find($id);
        if ($invoice === null) {
            http_response_code(404);
            return json_encode(['error' => 'not found']);
        }
        $totals = Pricing::invoiceTotal($invoice['lines'], $invoice['customer_type']);
        ob_start();
        include __DIR__ . '/../../templates/invoice.php';
        return ob_get_clean();
    }

    public function create(): string
    {
        $customer = trim($_POST['customer'] ?? '');
        $type = $_POST['customer_type'] ?? 'regular';
        $lines = json_decode($_POST['lines'] ?? '[]', true);
        if ($customer === '' || !is_array($lines) || count($lines) === 0) {
            http_response_code(422);
            return json_encode(['error' => 'customer and lines are required']);
        }
        $id = $this->repo->save(['customer' => $customer, 'customer_type' => $type, 'lines' => $lines]);
        header('Content-Type: application/json');
        return json_encode(['id' => $id, 'totals' => Pricing::invoiceTotal($lines, $type)]);
    }

    public function recent(): string
    {
        header('Content-Type: application/json');
        return json_encode($this->repo->listRecent((int) ($_GET['limit'] ?? 20)));
    }
}
