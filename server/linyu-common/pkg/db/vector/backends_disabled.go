//go:build !linyu_extended

package vector

func NewChromemClient() Vector  { panic("vector backend requires linyu_extended build") }
func NewWeaviateClient() Vector { panic("vector backend requires linyu_extended build") }
