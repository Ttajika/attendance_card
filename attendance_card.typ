// 出席カード（授業日つき）
// python attendance_code.py generate --date 2026-11-04 で作った CSV を読む
// 別の CSV を使うとき：typst compile attendance_card.typ --input csv=cards_20261111.csv
#import "card_layout.typ": *

#let course_name = "2026 F"   // courses.csv に授業名が登録されていればそちらを表示
#let cards = load_cards("cards_20261104.csv")

#card_sheet(cards, card => {
  let d = card.date.split("-")
  card_frame(card,
    course_name: course_name,
    title: [*出席カード*：下記のQRコードからアクセスし，フォームに記入してください．],
    side: text(size: 14pt, weight: "bold")[#d.at(0)年#d.at(1)月#d.at(2)日],
    footer: [※当日のみ有効・1枚1回限り],
  )
})
