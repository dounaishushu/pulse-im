<?php
namespace app;

use think\db\exception\DataNotFoundException;
use think\db\exception\ModelNotFoundException;
use think\exception\Handle;
use think\exception\HttpException;
use think\exception\HttpResponseException;
use think\exception\ValidateException;
use think\Response;
use Throwable;
use RuntimeException;

/**
 * 应用异常处理类
 */
class ExceptionHandle extends Handle
{
    /**
     * 不需要记录信息（日志）的异常类列表
     * @var array
     */
    protected $ignoreReport = [
        HttpException::class,
        HttpResponseException::class,
        ModelNotFoundException::class,
        DataNotFoundException::class,
        ValidateException::class,
    ];

    /**
     * 记录异常信息（包括日志或者其它方式记录）
     *
     * @access public
     * @param  Throwable $exception
     * @return void
     */
    public function report(Throwable $exception): void
    {
        // 使用内置的方式记录异常日志
        parent::report($exception);
    }

    /**
     * Render an exception into an HTTP response.
     *
     * @access public
     * @param \think\Request   $request
     * @param Throwable $e
     * @return Response
     */
    public function render($request, Throwable $e): Response
    {
        \app\Service\RequestTrace::failure($request, $e);
        if ($e instanceof HttpResponseException) return \app\Service\RequestTrace::decorate($request, $e->getResponse());
        // 添加自定义异常处理机制

        // 其他错误交给系统处理
        $path = ltrim($request->pathinfo(), '/');
        if ($request->isJson() || str_starts_with($path, 'internal/broadcast/') || str_starts_with($path, 'work-tasks') || str_starts_with($path, 'client/') || str_starts_with($path, 'admin/') || str_starts_with($path, 'wallets/') || str_starts_with($path, 'messages') || str_starts_with($path, 'red-packets') || str_starts_with($path, 'auth/') || str_starts_with($path, 'contacts') || str_starts_with($path, 'notifications') || str_starts_with($path, 'contact-requests') || str_starts_with($path, 'conversations') || str_starts_with($path, 'conversation-folders') || str_starts_with($path, 'uploads') || str_starts_with($path, 'blocks')) {
            $business = $e instanceof RuntimeException && !$e instanceof \PDOException && !$e instanceof \think\db\exception\PDOException;
            $status = $business ? 400 : 500;
            return \app\Service\RequestTrace::decorate($request, json([
                'ok' => false,
                'error' => [
                    'code' => $status === 400 ? 'BUSINESS_ERROR' : 'INTERNAL_ERROR',
                    'message' => $status === 400 ? $e->getMessage() : 'Internal server error.',
                ],
            ], $status)->header(['Cache-Control' => 'no-store']));
        }

        return \app\Service\RequestTrace::decorate($request, parent::render($request, $e));
    }
}
