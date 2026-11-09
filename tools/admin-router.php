<?php
declare(strict_types=1);

// Never return false here: the built-in server must not bypass the IP gate for static files.
require dirname(__DIR__) . '/backend/public/admin.php';
