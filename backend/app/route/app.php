<?php
// Compatibility entry: backend/route/app.php is the only route definition source.
// Register against the current ThinkPHP Route instance on every load.
require dirname(__DIR__, 2) . '/route/app.php';
