package geoip

import "testing"

func TestLocalizeRecognizedNamesWithoutIPLookup(t *testing.T) {
	for _, tc := range []struct{ input, want Region }{
		{Region{"China", "Anhui", "Hefei"}, Region{"中国", "安徽省", "合肥市"}},
		{Region{"China", "Henan", "Zhengzhou"}, Region{"中国", "河南省", "郑州市"}},
		{Region{"China", "Hubei", "Wuhan"}, Region{"中国", "湖北省", "武汉市"}},
		{Region{"China", "Shanghai", "Shanghai"}, Region{"中国", "上海市", "上海市"}},
		{Region{"China", "Shaanxi", "Xi’an"}, Region{"中国", "陕西省", "西安市"}},
		{Region{"China", "Shanxi", "Taiyuan"}, Region{"中国", "山西省", "太原市"}},
		{Region{"CN", "Guangdong", "Shenzhen City"}, Region{"中国", "广东省", "深圳市"}},
		{Region{"China", "Inner Mongolia", "Hohhot"}, Region{"中国", "内蒙古自治区", "呼和浩特市"}},
		{Region{"China", "Xinjiang", "Urumqi"}, Region{"中国", "新疆维吾尔自治区", "乌鲁木齐市"}},
		{Region{"Viet Nam", "Hanoi", "Hanoi"}, Region{"越南", "河内", "河内"}},
		{Region{"United States", "California", "Los Angeles"}, Region{"美国", "加利福尼亚州", "洛杉矶"}},
		{Region{"China", "", ""}, Region{"中国", "", ""}},
		{Region{"China", "未知省", "Unknown City"}, Region{"中国", "未知省", "Unknown City"}},
		{Region{"Unknown country", "Unknown province", "Unknown city"}, Region{"Unknown country", "Unknown province", "Unknown city"}},
		{Region{"中国", "北京市", "北京市"}, Region{"中国", "北京市", "北京市"}},
		{Region{}, Region{}},
	} {
		t.Run(tc.input.Country+"/"+tc.input.Province+"/"+tc.input.City, func(t *testing.T) {
			if got := Localize(tc.input); got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func BenchmarkLocalizeRegion(b *testing.B) {
	input := Region{"China", "Shaanxi", "Xi’an"}
	_ = Localize(input)
	b.ReportAllocs()
	for b.Loop() {
		_ = Localize(input)
	}
}
