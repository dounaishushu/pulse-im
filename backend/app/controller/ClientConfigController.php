<?php

namespace app\controller;

final class ClientConfigController
{
    public function index(\think\Request $request)
    {
        $announcement = (new \app\Service\AnnouncementService())->active();
        $navigation = (new \app\Service\ClientNavigationService())->get();
        $config = (new \app\Service\ClientConfigService())->forClient((string) $request->header('x-client-platform', ''), (string) $request->header('x-client-version', ''));
        return json(['ok' => true, 'data' => [
            'chat_notice' => $announcement['content'] ?? '',
            'announcement' => $announcement,
            'group_member_limit' => \app\Service\ConversationService::DEFAULT_GROUP_MEMBER_LIMIT,
            'explore_links' => $navigation['explore_links'],
            'show_group_member_count' => $config['show_group_member_count'],
            'latest_version' => $config['latest_version'],
            'minimum_version' => $config['minimum_version'],
            'pc_download_url' => $config['pc_download_url'],
            'android_download_url' => $config['android_download_url'],
            'ios_download_url' => $config['ios_download_url'],
            'update_description' => $config['update_description'],
            'force_update' => $config['force_update'],
            'register_require_avatar' => $config['register_require_avatar'],
            'max_register_accounts_per_ip' => $config['max_register_accounts_per_ip'],
            'mall_links' => $config['mall_links'],
        ]])->header(['Cache-Control' => 'no-store']);
    }
}
