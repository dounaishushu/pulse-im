<?php
namespace app\middleware;

use app\Service\RequestTrace;
use think\Request;

final class RequestDiagnostics
{
    public function handle(Request $request, \Closure $next)
    {
        RequestTrace::context($request);
        try { return RequestTrace::decorate($request, $next($request)); }
        catch (\Throwable $error) { RequestTrace::failure($request, $error); throw $error; }
    }
}
