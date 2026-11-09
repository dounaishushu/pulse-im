<?php
namespace app\controller;
final class RetiredFinanceController
{
    public function unavailable() { return json(['ok' => false, 'error' => ['code' => 'FEATURE_REMOVED', 'message' => '钱包与红包功能已移除。']], 410); }
}
