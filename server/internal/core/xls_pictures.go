package core

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"github.com/richardlehane/mscfb"
	"io"
	"os"
)

type embeddedPicture struct {
	Extension string
	Data      []byte
}
type officeRecord struct {
	Type     uint16
	Instance uint16
	Data     []byte
	Children []officeRecord
}

func officeRecords(raw []byte, depth int, budget *int) ([]officeRecord, error) {
	if depth > 16 {
		return nil, mediaError("xls_drawing_depth")
	}
	out := []officeRecord{}
	for len(raw) > 0 {
		if len(raw) < 8 {
			return nil, mediaError("xls_drawing_invalid")
		}
		*budget = *budget + 1
		if *budget > 20000 {
			return nil, mediaError("xls_drawing_count")
		}
		flags := binary.LittleEndian.Uint16(raw)
		typ := binary.LittleEndian.Uint16(raw[2:])
		n := uint64(binary.LittleEndian.Uint32(raw[4:]))
		if n > uint64(len(raw)-8) {
			return nil, mediaError("xls_drawing_invalid")
		}
		record := officeRecord{Type: typ, Instance: flags >> 4, Data: raw[8 : 8+n]}
		if flags&15 == 15 {
			children, e := officeRecords(record.Data, depth+1, budget)
			if e != nil {
				return nil, e
			}
			record.Children = children
		}
		out = append(out, record)
		raw = raw[8+n:]
	}
	return out, nil
}
func officeWalk(records []officeRecord, fn func(officeRecord)) {
	for _, r := range records {
		fn(r)
		officeWalk(r.Children, fn)
	}
}
func xlsEmbeddedPictures(path string) (map[int]embeddedPicture, error) {
	file, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer file.Close()
	cfb, e := mscfb.New(file)
	if e != nil {
		return nil, e
	}
	var workbook []byte
	for entry, e := cfb.Next(); e == nil; entry, e = cfb.Next() {
		if entry.Name == "Workbook" || entry.Name == "Book" {
			workbook, e = io.ReadAll(io.LimitReader(cfb, 80<<20+1))
			if e != nil || len(workbook) > 80<<20 {
				return nil, mediaError("xls_size_limit")
			}
			break
		}
	}
	if len(workbook) == 0 {
		return nil, mediaError("xls_workbook_missing")
	}
	out := map[int]embeddedPicture{}
	imageRow := 0
	var legacyImage []byte
	flushLegacy := func() error {
		if len(legacyImage) == 0 {
			return nil
		}
		defer func() { legacyImage = nil }()
		if len(legacyImage) < 20 || binary.LittleEndian.Uint16(legacyImage) != 9 {
			return mediaError("xls_bitmap_invalid")
		}
		n := int(binary.LittleEndian.Uint32(legacyImage[4:]))
		if n > len(legacyImage)-8 {
			return mediaError("xls_bitmap_invalid")
		}
		dib := legacyImage[8 : 8+n]
		if binary.LittleEndian.Uint32(dib) != 12 {
			return mediaError("xls_bitmap_invalid")
		}
		if binary.LittleEndian.Uint16(dib[8:]) != 1 || binary.LittleEndian.Uint16(dib[10:]) != 24 {
			return mediaError("xls_bitmap_invalid")
		}
		bmp := make([]byte, 54+len(dib)-12)
		copy(bmp, []byte("BM"))
		binary.LittleEndian.PutUint32(bmp[2:], uint32(len(bmp)))
		binary.LittleEndian.PutUint32(bmp[10:], 54)
		binary.LittleEndian.PutUint32(bmp[14:], 40)
		binary.LittleEndian.PutUint32(bmp[18:], uint32(binary.LittleEndian.Uint16(dib[4:])))
		binary.LittleEndian.PutUint32(bmp[22:], uint32(binary.LittleEndian.Uint16(dib[6:])))
		binary.LittleEndian.PutUint16(bmp[26:], 1)
		binary.LittleEndian.PutUint16(bmp[28:], 24)
		copy(bmp[54:], dib[12:])

		out[imageRow] = embeddedPicture{".bmp", bmp}
		return nil
	}
	var group, sheet []byte
	which := 0
	sheetNumber := 0
	activeSheet := false
	for len(workbook) > 0 {
		if len(workbook) < 4 {
			if len(bytes.Trim(workbook, "\x00")) == 0 {
				break
			}
			return nil, mediaError("xls_record_invalid")
		}
		typ, n := binary.LittleEndian.Uint16(workbook), int(binary.LittleEndian.Uint16(workbook[2:]))
		if n > len(workbook)-4 {
			return nil, mediaError("xls_record_invalid")
		}
		data := workbook[4 : 4+n]
		workbook = workbook[4+n:]
		if typ == 0x809 && len(data) >= 4 {
			if binary.LittleEndian.Uint16(data[2:]) == 0x10 {
				sheetNumber++
				activeSheet = sheetNumber == 1
			} else {
				activeSheet = false
			}
		}
		if typ != 0x3c {
			if e := flushLegacy(); e != nil {
				return nil, e
			}
			which = 0
		}
		switch typ {
		case 0x5d:
			if activeSheet && len(data) >= 16 && binary.LittleEndian.Uint16(data[4:]) == 8 {
				imageRow = int(binary.LittleEndian.Uint16(data[14:])) + 1
			}
		case 0x7f:
			if activeSheet && imageRow > 0 {
				legacyImage = append(legacyImage, data...)
				which = 3
			}
		case 0xeb:
			group = append(group, data...)
			which = 1
		case 0xec:
			if activeSheet {
				sheet = append(sheet, data...)
				which = 2
			}
		case 0x3c:
			if which == 1 {
				group = append(group, data...)
			} else if which == 2 {
				sheet = append(sheet, data...)
			} else if which == 3 {
				legacyImage = append(legacyImage, data...)
			}
		}
	}
	if e := flushLegacy(); e != nil {
		return nil, e
	}
	if len(group) == 0 || len(sheet) == 0 {
		return out, nil
	}
	budget := 0
	globals, e := officeRecords(group, 0, &budget)
	if e != nil {
		return nil, e
	}
	pictures := []embeddedPicture{}
	officeWalk(globals, func(r officeRecord) {
		if r.Type != 0xf007 {
			return
		}
		picture := embeddedPicture{}
		if len(r.Data) >= 44 {
			offset := 36 + int(r.Data[33])
			if offset+8 <= len(r.Data) {
				blob := r.Data[offset:]
				typ := binary.LittleEndian.Uint16(blob[2:])
				size := int(binary.LittleEndian.Uint32(blob[4:]))
				if size <= len(blob)-8 {
					body := blob[8 : 8+size]
					for _, skip := range []int{17, 33} {
						if skip >= len(body) {
							continue
						}
						data := body[skip:]
						if (typ == 0xf01d || typ == 0xf02a) && bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}) {
							picture = embeddedPicture{".jpg", data}
							break
						}
						if typ == 0xf01e && bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
							picture = embeddedPicture{".png", data}
							break
						}
						if typ == 0xf01f && len(data) >= 40 {
							headerSize := int(binary.LittleEndian.Uint32(data))
							if headerSize >= 40 && headerSize <= len(data) {
								bpp := binary.LittleEndian.Uint16(data[14:])
								colors := binary.LittleEndian.Uint32(data[32:])
								if colors == 0 && bpp <= 8 {
									colors = 1 << bpp
								}
								pixelOffset := 14 + headerSize + int(colors)*4
								bitmap := make([]byte, 14+len(data))
								copy(bitmap, []byte("BM"))
								binary.LittleEndian.PutUint32(bitmap[2:], uint32(len(bitmap)))
								binary.LittleEndian.PutUint32(bitmap[10:], uint32(pixelOffset))
								copy(bitmap[14:], data)
								picture = embeddedPicture{".bmp", bitmap}
								break
							}
						}
					}
				}
			}
		}
		pictures = append(pictures, picture)
	})
	drawings, e := officeRecords(sheet, 0, &budget)
	if e != nil {
		return nil, e
	}
	officeWalk(drawings, func(r officeRecord) {
		if r.Type != 0xf004 {
			return
		}
		row, index := -1, 0
		for _, c := range r.Children {
			if c.Type == 0xf010 && len(c.Data) >= 18 {
				row = int(binary.LittleEndian.Uint16(c.Data[6:])) + 1
			}
			if c.Type == 0xf00b {
				count := int(c.Instance)
				if count*6 > len(c.Data) {
					continue
				}
				for i := 0; i < count; i++ {
					p := c.Data[i*6:]
					if binary.LittleEndian.Uint16(p)&0x3fff == 0x104 {
						index = int(binary.LittleEndian.Uint32(p[2:]))
					}
				}
			}
		}
		if row > 0 && index > 0 && index <= len(pictures) {
			out[row] = pictures[index-1]
		}
	})
	for row, p := range out {
		if len(p.Data) == 0 {
			return nil, fmt.Errorf("unsupported embedded image at row %d", row)
		}
	}
	return out, nil
}
