<?php
namespace app\controller;

use think\Request;

/** Compatibility routes cannot create or settle red packets. */
final class RedPacketController
{
    public function create(Request $request) { return (new RetiredFinanceController())->unavailable(); }
    public function claim(Request $request) { return (new RetiredFinanceController())->unavailable(); }
}
