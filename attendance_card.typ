#import "@preview/tiaoma:0.3.0": qrcode
// カード寸法と余白（切断ガイド線の位置もここから計算する）
#let card_w = 91mm
#let card_h = 55mm
#let margin_x = 14mm
#let margin_y = 10mm
#let n_cols = 2
#let n_rows = 5

// 切断用ガイド線：カードの境界位置に用紙の端から端まで細い破線を引く
#let guide_stroke = (paint: luma(150), thickness: 0.3pt, dash: "dashed")
#let cut_guides = {
  for i in range(n_cols + 1) {
    place(dx: margin_x + i * card_w, line(angle: 90deg, length: 297mm, stroke: guide_stroke))
  }
  for j in range(n_rows + 1) {
    place(dy: margin_y + j * card_h, line(length: 210mm, stroke: guide_stroke))
  }
}

#set page(height: 297mm, width: 210mm,
  margin: (top: margin_y, bottom: margin_y, left: margin_x, right: margin_x),
  background: cut_guides)
#set text(font: "Harano Aji Gothic")

#let card_body(it) = box(width: card_w, height: card_h, inset: 6mm)[#it]

// python attendance_code.py generate --date 2026-11-04 --count 100 で作ったCSV
// typst compile attendance_card.typ --input csv=cards_20261111.csv のように指定すると，その CSV を読み込む
#let data = csv(sys.inputs.at("csv", default: "cards_20261104.csv"))
#let rows = data.slice(1) // 見出し行を除く
#let course_name = "2026 F"

#grid(
  columns: (card_w,) * n_cols,
  rows: card_h,
  ..rows.map(r => {
    let (code, url, date, number, course) = r
    let d = date.split("-")
    card_body[
      *出席点記録カード*：下記のQRコードからアクセスし，フォームに記入してください．
      #grid(
        columns: (auto, 1fr),
        column-gutter: 4mm,
        qrcode(url, width: 26mm),
        align(horizon)[
          #text(size: 14pt, weight: "bold")[#d.at(0)年#d.at(1)月#d.at(2)日]
          #v(1mm)
          #text(size: 7pt)[QRが読めない場合のコード：] \
          #box(text(size: 8pt, font: "DejaVu Sans Mono")[#code])
        ],
      )
      #v(1fr)
      #text(size: 8pt)[※当日のみ有効・1枚1回限り] #h(1fr) #course_name. No. #number
    ]
  })
)
