<?php
require_once __DIR__ . '/src/controllers/InvoiceController.php';

// Plain-PHP route table: method, path, handler. The inventory reads this file.
return [
    ['GET', '/invoices/{id}', [InvoiceController::class, 'show']],
    ['POST', '/invoices', [InvoiceController::class, 'create']],
    ['GET', '/invoices', [InvoiceController::class, 'recent']],
];
