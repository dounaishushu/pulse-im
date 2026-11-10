//go:build !linyu_extended

package storage

import "github.com/linyu-im/linyu-server/linyu-common/pkg/config"

func NewS3Storage(_ config.S3StorageConfig) Storage   { panic("S3 requires linyu_extended build") }
func NewOssStorage(_ config.OssStorageConfig) Storage { panic("OSS requires linyu_extended build") }
