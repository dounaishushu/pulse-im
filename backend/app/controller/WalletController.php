<?php
namespace app\controller;

use think\Request;

/** Compatibility only: no public financial read or write operation remains. */
final class WalletController
{
    public function createRequest(Request $request) { return $this->removed(); }
    public function requests(Request $request) { return $this->removed(); }
    public function cancelRequest(Request $request) { return $this->removed(); }
    public function adminRequests(Request $request) { return $this->removed(); }
    public function reviewRequest(Request $request) { return $this->removed(); }
    public function topUp(Request $request) { return $this->removed(); }
    public function debit(Request $request) { return $this->removed(); }
    public function balance(Request $request) { return $this->removed(); }
    public function ledger(Request $request) { return $this->removed(); }
    private function removed() { return (new RetiredFinanceController())->unavailable(); }
}
