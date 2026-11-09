<?php
namespace app\Service;

/** Shared by the production entry point and isolated HTTP integration routers. */
final class AdminIpRequestGuard
{
    public function __construct(private AdminIpAccessService $access) {}

    public function handle(array $server, string $rawBody = '', array $query = []): ?array
    {
        if (AdminIpAccessService::hasMalformedPathQuery($server, $query)) return AdminIpAccessService::notFoundResponse();
        if (AdminIpAccessService::isControlRequest($server, $query)) return (new AdminIpControlApi($this->access))->handle($server, $rawBody);
        // This is a trusted FastCGI server parameter, never an HTTP_* header.
        if ((($server['ADMIN_ACCESS_REQUIRED'] ?? '') === '1' || AdminIpAccessService::isAdminRequest($server, $query)) && !$this->access->allows($server)) return AdminIpAccessService::notFoundResponse();
        return null;
    }
}
