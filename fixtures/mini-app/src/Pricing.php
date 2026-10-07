<?php
require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Money.php';

// T1: domain logic with real branching. Characterization tests should pin every branch.
class Pricing
{
    /** Duplicate of round2() — exists to test dedupe. */
    public static function r2(float $v): float
    {
        return round($v + 0.0000001, 2);
    }

    /**
     * Legacy quirks that must survive migration:
     *  - quantity 0 or negative → price 0 (not an error)
     *  - discount above MAX_DISCOUNT is capped silently
     *  - customer type 'vip' gets an extra 5% AFTER the discount, only when subtotal > 100
     *  - tax is applied on the discounted amount, rounded per line
     */
    public static function lineTotal(float $unitPrice, int $qty, float $discount = 0.0, string $customerType = 'regular'): float
    {
        if ($qty <= 0) {
            return 0.0;
        }
        if ($discount < 0) {
            $discount = 0.0;
        }
        if ($discount > MAX_DISCOUNT) {
            $discount = MAX_DISCOUNT;
        }
        $subtotal = $unitPrice * $qty;
        $discounted = $subtotal * (1 - $discount);
        if ($customerType === 'vip' && $subtotal > 100) {
            $discounted = $discounted * 0.95;
        }
        $withTax = $discounted * (1 + TAX_RATE);
        return self::r2($withTax);
    }

    /** @param array<int, array{price: float, qty: int, discount?: float}> $lines */
    public static function invoiceTotal(array $lines, string $customerType = 'regular'): array
    {
        $net = 0.0;
        $gross = 0.0;
        foreach ($lines as $line) {
            $qty = (int) ($line['qty'] ?? 0);
            $price = (float) ($line['price'] ?? 0);
            $disc = (float) ($line['discount'] ?? 0);
            $g = self::lineTotal($price, $qty, $disc, $customerType);
            $gross += $g;
            $net += $qty > 0 ? round2($g / (1 + TAX_RATE)) : 0.0;
        }
        return [
            'net' => round2($net),
            'tax' => round2($gross - $net),
            'gross' => round2($gross),
            'currency' => CURRENCY,
        ];
    }
}
