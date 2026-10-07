<?php
// Dead code: nothing includes or references this file, statically or by string.

class OldCsvExport
{
    public static function run(array $rows): string
    {
        $out = '';
        foreach ($rows as $r) {
            $out .= implode(';', $r) . "\n";
        }
        return $out;
    }
}
