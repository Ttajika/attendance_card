// 日付なしカード（発言カードなど，いつ使ってもよいカード）
// python attendance_code.py generate --no-date で作った CSV を読む
// 別の CSV を使うとき：typst compile nodate_card.typ --input csv=cards_nodate_1-100.csv
#import "card_layout.typ": *

#let course_name = "2026 F"   // courses.csv に授業名が登録されていればそちらを表示
#let card_name = "発言カード"   // カードの名前（用途に合わせて変える）
#let cards = load_cards("cards_nodate_1-100.csv")

#card_sheet(cards, card => card_frame(card,
  course_name: course_name,
  title: [*#card_name*：下記のQRコードからアクセスし，フォームに記入してください．],
  side: text(size: 14pt, weight: "bold")[#card_name],
  footer: [※1枚1回限り],
))
