//go:build !linyu_extended

package eventbus

import "errors"

func NewRocketMQEventBus() (EventBus, error) {
	return nil, errors.New("RocketMQ requires linyu_extended build")
}
