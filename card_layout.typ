// 出席カード・日付なしカード共通のレイアウト（A4 に 91×55mm のカードを 2列×5段，切断ガイド線つき）
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

// CSV を読み込み，見出し行を除いた各行を辞書 (code, url, date, number, course) にして返す
// typst compile xxx.typ --input csv=cards_20261111.csv のように指定すると，その CSV を読み込む
// 列は見出し行の名前で読む（course_name 列がない古い CSV も読める）
#let load_cards(default) = {
  let data = csv(sys.inputs.at("csv", default: default))
  let header = data.first()
  data.slice(1).map(r => {
    let card = (:)
    for (k, v) in header.zip(r) { card.insert(k, v) }
    card
  })
}

// カード1枚の共通の枠：見出し行・QRコード＋右側の内容・最下行
// QRコード右側の授業名は，CSV の course_name 列（courses.csv に登録した名前）があればそれを，
// なければ引数 course_name を使う
#let card_frame(card, title: [], side: [], footer: [], course_name: "") = box(
  width: card_w, height: card_h, inset: 6mm,
)[
  #let name = card.at("course_name", default: "")
  #let name = if name == "" { course_name } else { name }
  #title
  #grid(
    columns: (auto, 1fr),
    column-gutter: 4mm,
    qrcode(card.url, width: 26mm),
    align(horizon)[
      #if name != "" [#text(size: 9pt)[#name] \ ]
      #side
      #v(1mm)
      #text(size: 7pt)[QRが読めない場合のコード：] \
      #box(text(size: 8pt, font: "DejaVu Sans Mono")[#card.code])
    ],
  )
  #v(1fr)
  #text(size: 8pt)[#footer] #h(1fr) No. #card.number
]

// カードを並べた用紙全体。make_card は辞書を受け取ってカード1枚を返す関数
#let card_sheet(cards, make_card) = {
  set page(height: 297mm, width: 210mm,
    margin: (top: margin_y, bottom: margin_y, left: margin_x, right: margin_x),
    background: cut_guides)
  set text(font: "Harano Aji Gothic")
  grid(
    columns: (card_w,) * n_cols,
    rows: card_h,
    ..cards.map(make_card),
  )
}
