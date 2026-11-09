USE `pulse_im`;

-- 消息服务已经支持视频、站内名片和窗口抖动，数据库枚举必须同步覆盖这些类型。
ALTER TABLE `messages`
  MODIFY COLUMN `type` ENUM('text','image','video','file','voice','contact_card','shake','red_packet','system') NOT NULL;
