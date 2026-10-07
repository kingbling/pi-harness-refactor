<?php
// T0: pure helpers. `round2` is duplicated as Pricing::r2 — the implementer should dedupe.

function round2(float $v): float
{
    return round($v + 0.0000001, 2);
}

function format_money(float $v, string $currency = CURRENCY): string
{
    return number_format($v, 2, ',', '.') . ' ' . $currency;
}

function parse_money(string $s): float
{
    if ($s === '' || $s === '0') {
        return 0.0;
    }
    $clean = str_replace(['.', ' ', 'EUR'], '', $s);
    $clean = str_replace(',', '.', $clean);
    return (float) $clean;
}
