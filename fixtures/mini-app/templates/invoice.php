<?php /** @var array $invoice @var array $totals */ ?>
<!doctype html>
<html>
<body>
  <h1>Invoice #<?= (int) $invoice['id'] ?></h1>
  <p>Customer: <?= htmlspecialchars($invoice['customer']) ?> (<?= htmlspecialchars($invoice['customer_type']) ?>)</p>
  <table>
    <?php foreach ($invoice['lines'] as $line): ?>
      <tr>
        <td><?= (int) $line['qty'] ?> ×</td>
        <td><?= format_money((float) $line['price']) ?></td>
        <td><?= isset($line['discount']) ? ((int) ($line['discount'] * 100)) . '%' : '' ?></td>
      </tr>
    <?php endforeach; ?>
  </table>
  <p>Net: <?= format_money($totals['net']) ?></p>
  <p>Tax: <?= format_money($totals['tax']) ?></p>
  <p><strong>Gross: <?= format_money($totals['gross']) ?></strong></p>
</body>
</html>
