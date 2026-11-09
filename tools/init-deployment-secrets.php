<?php
declare(strict_types=1);

// Run only in the extracted deployment directory. Never prints secret values.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$envPath = dirname(__DIR__) . '/backend/.env';
$temporary = null;
$oldMask = umask(0077);
$exitCode = 0;

function assertPrivateEnvPath(string $path): void
{
    for ($part = $path; ; $part = dirname($part)) {
        if (is_link($part)) throw new RuntimeException('Symbolic links are not supported.');
        if (dirname($part) === $part) break;
    }
    if (!is_file($path) || !is_readable($path)) throw new RuntimeException('Create backend/.env before running this tool.');
}

try {
    assertPrivateEnvPath($envPath);
    $original = file_get_contents($envPath);
    if ($original === false) throw new RuntimeException('Unable to read backend/.env.');
    $parsed = @parse_ini_string($original, true, INI_SCANNER_RAW);
    if ($parsed === false) throw new RuntimeException('Invalid backend/.env format.');

    $names = ['MEDIA_SIGNING_KEY', 'PASSWORD_VAULT_KEY'];
    $lines = preg_split('/(\r\n|\n|\r)/', $original, -1, PREG_SPLIT_DELIM_CAPTURE);
    $lineEnding = str_contains($original, "\r\n") ? "\r\n" : "\n";
    $positions = [];
    $values = [];
    foreach ($parsed as $name => $value) {
        if (in_array(strtoupper((string) $name), $names, true) && !is_array($value)) {
            $values[strtoupper((string) $name)] = (string) $value;
        }
    }
    $inSection = false;
    foreach ($lines as $index => $line) {
        if ($index % 2 !== 0) continue;
        if (preg_match('/^\s*\[/', $line)) $inSection = true;
        if ($inSection || !preg_match('/^\s*(MEDIA_SIGNING_KEY|PASSWORD_VAULT_KEY)\s*=/i', $line, $match)) continue;
        $name = strtoupper($match[1]);
        if (isset($positions[$name])) throw new RuntimeException('Duplicate deployment secret field.');
        $positions[$name] = $index;
    }

    $created = [];
    $prepend = [];
    foreach ($names as $name) {
        if (($values[$name] ?? '') !== '') continue;
        $value = $name === 'PASSWORD_VAULT_KEY'
            ? '"base64:' . base64_encode(random_bytes(32)) . '"'
            : bin2hex(random_bytes(32));
        $replacement = $name . '=' . $value;
        if (isset($positions[$name])) {
            // A blank field must fit on one line, so replacing it cannot discard
            // any adjacent configuration from a multiline INI value.
            if (!preg_match('/^\s*[^=]+\s*=\s*(?:""|\'\')?\s*(?:[;#].*)?$/', $lines[$positions[$name]])) {
                throw new RuntimeException('Unsupported blank secret field format.');
            }
            $lines[$positions[$name]] = $replacement;
        } else {
            // Global keys precede any INI sections that may already exist.
            $prepend[] = $replacement;
        }
        $created[] = $name;
    }

    if ($created !== []) {
        $updated = ($prepend === [] ? '' : implode($lineEnding, $prepend) . $lineEnding) . implode('', $lines);
        $temporary = dirname($envPath) . '/.env.init-' . bin2hex(random_bytes(12));
        $stream = @fopen($temporary, 'x+b');
        if ($stream === false) throw new RuntimeException('Unable to create private configuration file.');
        try {
            if (!chmod($temporary, 0600)) throw new RuntimeException('Unable to protect configuration permissions.');
            if (fwrite($stream, $updated) !== strlen($updated) || !fflush($stream)) throw new RuntimeException('Unable to write configuration.');
            if (function_exists('fsync') && !fsync($stream)) throw new RuntimeException('Unable to flush configuration.');
        } finally {
            fclose($stream);
        }
        clearstatcache(true, $envPath);
        assertPrivateEnvPath($envPath);
        if (file_get_contents($envPath) !== $original) throw new RuntimeException('Configuration changed; run the tool again.');
        if (!@rename($temporary, $envPath)) throw new RuntimeException('Unable to replace configuration atomically.');
        $temporary = null;
    }
    if (!chmod($envPath, 0600)) throw new RuntimeException('Unable to protect configuration permissions.');
    foreach ($names as $name) echo $name, ': ', in_array($name, $created, true) ? 'initialized' : 'preserved', PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, ($error instanceof RuntimeException ? $error->getMessage() : 'Deployment secret initialization failed.') . PHP_EOL);
    $exitCode = 1;
} finally {
    if ($temporary !== null && is_file($temporary) && !is_link($temporary)) @unlink($temporary);
    umask($oldMask);
}
exit($exitCode);
