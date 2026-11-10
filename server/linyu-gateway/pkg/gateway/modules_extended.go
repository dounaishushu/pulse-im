//go:build linyu_extended

package gateway

// Optional upstream modules are kept for reference, and omitted from the default build.
import (
	_ "github.com/linyu-im/linyu-server/linyu-ai/pkg/api"
	_ "github.com/linyu-im/linyu-server/linyu-application/pkg/api"
	_ "github.com/linyu-im/linyu-server/linyu-cloud-drive/pkg/api"
	_ "github.com/linyu-im/linyu-server/linyu-voip-chat/pkg/api"
)
