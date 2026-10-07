<?php
// T0: shared constants/config. Nothing here has behavior.

const TAX_RATE = 0.19;
const CURRENCY = 'EUR';
const MAX_DISCOUNT = 0.5;

class Config
{
    public static function dsn(): string
    {
        return getenv('APP_DSN') ?: 'sqlite::memory:';
    }

    public static function feature(string $name): bool
    {
        $flags = ['new_pricing' => true, 'pdf_export' => false];
        return $flags[$name] ?? false;
    }
}
