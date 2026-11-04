#!/usr/bin/env python3
"""出席カード用コードの生成・デコードツール

コードの中身（13バイト → Crockford Base32 で21文字）:
    nonce(4B, 乱数) | 暗号化された [日付(2B) | カード番号(2B) | 授業ID(1B)] | 改ざん検知タグ(4B)
  - 暗号化・タグとも秘密鍵 (secret.key) を使う HMAC-SHA256 ベース
  - 鍵がなければ日付・番号は読めず、偽造もできない

使い方:
  1) 鍵の作成（最初の1回だけ。secret.key は絶対に配布しないこと）
       python attendance_code.py keygen
  1') 授業IDと授業名の登録（任意。courses.csv に保存され，カードとデコード結果に授業名が入る）
       python attendance_code.py course add "ミクロ経済学 出席" --id 3
       python attendance_code.py course list
  2) カード用CSVの生成（Typst が読む）
       python attendance_code.py generate --date 2026-11-04 --count 100 --start 1 --course 1
       → cards_20261104.csv（--date を省略すると今日の日付）
     毎週の授業15回分をまとめて:
       python attendance_code.py generate --date 2026-10-07 --repeat 15
       → cards_20261007.csv, cards_20261014.csv, ...（--merge で1ファイルに）
     日付なしカード（発言カードなど，いつ使ってもよいもの）:
       python attendance_code.py generate --no-date --count 100 --start 1 --course 2
       → cards_nodate_1-100.csv（印刷は nodate_card.typ）
  3) フォーム回答のデコード（Googleフォームの回答をCSVでダウンロードしたもの）
       python attendance_code.py decode 回答.csv
       → 回答_decoded.csv（日付・カード番号・判定の列を追加）
     単発の確認:
       python attendance_code.py check 7K3Q-....
"""
import argparse
import csv
import datetime as dt
import hashlib
import hmac
import os
import re
import secrets
import sys
import urllib.parse

KEY_FILE = "secret.key"
COURSES_FILE = "courses.csv"  # 授業IDと授業名の対応表（id,name）
FORM_URL = ("https://docs.google.com/forms/d/e/"
            "1FAIpQLSdL53D36dkF71oCQuEt-iHL7rWX-MyWRqRe1L0xV4s-30LaHw/"
            "viewform?usp=pp_url&entry.1091180216=")
EPOCH = dt.date(2020, 1, 1)  # 日付フィールド 0（＝この日）は「日付なし」の印として使う
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford Base32（I,L,O,U なし）
CODE_RE = re.compile(r"[0-9A-Za-z]{5}(?:-?[0-9A-Za-z]{4}){4}")


# ---------- 鍵 ----------
def load_key(path=KEY_FILE):
    if not os.path.exists(path):
        sys.exit(f"鍵ファイル {path} がありません。先に keygen を実行してください。")
    with open(path) as f:
        return bytes.fromhex(f.read().strip())


def keygen(path=KEY_FILE):
    if os.path.exists(path):
        sys.exit(f"{path} は既にあります（上書きすると既存カードがデコードできなくなります）。")
    with open(path, "w") as f:
        f.write(secrets.token_hex(32) + "\n")
    print(f"鍵を {path} に保存しました。このファイルはバックアップし、学生に渡さないこと。")


# ---------- 授業IDの対応表 ----------
def load_courses(path=COURSES_FILE):
    """{授業ID: 授業名} を返す。ファイルがなければ空。"""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {int(r["id"]): r["name"] for r in csv.DictReader(f)}


def save_courses(courses, path=COURSES_FILE):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name"])
        for i in sorted(courses):
            w.writerow([i, courses[i]])


def resolve_course(arg: str) -> int:
    """--course の値（番号 or 授業名）を授業IDにする。"""
    if arg.isdigit():
        cid = int(arg)
        if not 0 <= cid < 256:
            sys.exit("授業IDは 0〜255 です。")
        return cid
    ids = [i for i, n in load_courses().items() if n == arg]
    if not ids:
        sys.exit(f"授業名「{arg}」が {COURSES_FILE} にありません。"
                 f"先に course add で登録してください。")
    return ids[0]


# ---------- Base32 ----------
def b32encode(data: bytes) -> str:
    n, bits = int.from_bytes(data, "big"), len(data) * 8
    nchar = -(-bits // 5)
    n <<= nchar * 5 - bits
    s = "".join(ALPHABET[(n >> (5 * i)) & 31] for i in reversed(range(nchar)))
    return "-".join([s[:5]] + [s[i:i + 4] for i in range(5, len(s), 4)])


def b32decode(s: str, nbytes: int = 13) -> bytes:
    s = s.upper().replace("-", "").replace(" ", "")
    s = s.replace("O", "0").replace("I", "1").replace("L", "1")  # 読み間違い対策
    n = 0
    for c in s:
        n = n * 32 + ALPHABET.index(c)
    n >>= len(s) * 5 - nbytes * 8
    return n.to_bytes(nbytes, "big")


# ---------- 暗号化・復号 ----------
def _mac(key, label, data):
    return hmac.new(key, label + data, hashlib.sha256).digest()


def encode(key, date, number: int, course: int = 0) -> str:
    """date が None なら日付なしカード（日付フィールド 0）。"""
    days = 0 if date is None else (date - EPOCH).days
    assert (date is None or days > 0) and days < 65536 and 0 <= number < 65536 and 0 <= course < 256
    nonce = secrets.token_bytes(4)
    plain = days.to_bytes(2, "big") + number.to_bytes(2, "big") + bytes([course])
    stream = _mac(key, b"enc", nonce)[:5]
    cipher = bytes(a ^ b for a, b in zip(plain, stream))
    tag = _mac(key, b"tag", nonce + cipher)[:4]
    return b32encode(nonce + cipher + tag)


def decode(key, code: str):
    """(日付, 番号, 授業ID) を返す（日付なしカードの日付は None）。不正なコードなら None。"""
    try:
        raw = b32decode(code)
    except (ValueError, OverflowError):
        return None
    nonce, cipher, tag = raw[:4], raw[4:9], raw[9:]
    if not hmac.compare_digest(tag, _mac(key, b"tag", nonce + cipher)[:4]):
        return None
    stream = _mac(key, b"enc", nonce)[:5]
    plain = bytes(a ^ b for a, b in zip(cipher, stream))
    days = int.from_bytes(plain[:2], "big")
    date = None if days == 0 else EPOCH + dt.timedelta(days=days)
    return date, int.from_bytes(plain[2:4], "big"), plain[4]


def extract_code(text: str):
    """セル内の文字列（URLが丸ごと入っていても可）からコードを取り出す。"""
    text = urllib.parse.unquote(text or "")
    # URL の場合，フォームID（1FAIpQ...）もコードの形に一致してしまうので，末尾にある最後の一致を使う
    ms = CODE_RE.findall(text)
    return ms[-1] if ms else None


# ---------- コマンド ----------
def write_cards(key, path, dates, start, count, course):
    name = load_courses().get(course, "")
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["code", "url", "date", "number", "course", "course_name"])
        for date in dates:
            for no in range(start, start + count):
                c = encode(key, date, no, course)
                w.writerow([c, FORM_URL + c, date.isoformat() if date else "", no, course, name])
    print(f"{len(dates)} 回分 × {count} 枚を {path} に書き出しました。")


def cmd_generate(a):
    key = load_key()
    a.course = resolve_course(a.course)
    if a.no_date:
        if a.date or a.repeat != 1 or a.merge:
            sys.exit("--no-date は --date / --repeat / --merge と一緒には使えません。")
        out = a.out or f"cards_nodate_{a.start}-{a.start + a.count - 1}.csv"
        write_cards(key, out, [None], a.start, a.count, a.course)
        return
    first = dt.date.fromisoformat(a.date) if a.date else dt.date.today()
    if a.repeat < 1:
        sys.exit("--repeat は 1 以上にしてください。")
    dates = [first + dt.timedelta(days=a.interval * i) for i in range(a.repeat)]
    if a.merge or len(dates) == 1:
        out = a.out or (f"cards_{dates[0]:%Y%m%d}.csv" if len(dates) == 1 else
                        f"cards_{dates[0]:%Y%m%d}-{dates[-1]:%Y%m%d}.csv")
        write_cards(key, out, dates, a.start, a.count, a.course)
    else:
        if a.out:
            sys.exit("複数回分を別ファイルに出すときは --out を使えません（--merge なら可）。")
        for date in dates:
            write_cards(key, f"cards_{date:%Y%m%d}.csv", [date], a.start, a.count, a.course)


def cmd_decode(a):
    key = load_key()
    with open(a.responses, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    if a.column:
        col = header.index(a.column)
    else:  # コードらしき値が最も多い列を自動検出
        col = max(range(len(header)),
                  key=lambda j: sum(bool(extract_code(r[j])) for r in body if j < len(r)))
    print(f"コード列: 「{header[col]}」")

    seen = {}
    courses = load_courses()
    out_rows = [header + ["日付", "カードNo", "授業ID", "授業名", "判定"]]
    for i, r in enumerate(body):
        code = extract_code(r[col]) if col < len(r) else None
        res = decode(key, code) if code else None
        if res is None:
            out_rows.append(r + ["", "", "", "", "不正コード"])
            continue
        date, no, course = res
        k = (date, no, course)
        status = "OK" if k not in seen else f"重複（{seen[k] + 2}行目と同じカード）"
        seen.setdefault(k, i)
        out_rows.append(r + [date.isoformat() if date else "なし", no, course,
                             courses.get(course, ""), status])

    out = a.out or os.path.splitext(a.responses)[0] + "_decoded.csv"
    with open(out, "w", newline="", encoding="utf-8-sig") as f:  # Excelで文字化けしないようBOM付き
        csv.writer(f).writerows(out_rows)
    n_ok = sum(r[-1] == "OK" for r in out_rows[1:])
    print(f"{len(body)} 件中 OK {n_ok} 件 → {out}")


def cmd_check(a):
    res = decode(load_key(), extract_code(a.code) or a.code)
    if res is None:
        print("不正なコードです")
        return
    name = load_courses().get(res[2])
    print(f"日付 {res[0] or 'なし'}  カードNo {res[1]}  授業ID {res[2]}"
          + (f"（{name}）" if name else ""))


def cmd_course(a):
    courses = load_courses()
    if a.action == "add":
        if not a.name:
            sys.exit("授業名を指定してください（例：course add \"ミクロ経済学 出席\"）")
        if a.name.isdigit():
            sys.exit("授業名を数字だけにはできません（番号と区別がつかないため）。")
        if a.name in courses.values():
            sys.exit(f"「{a.name}」は既に登録されています。")
        cid = a.id if a.id is not None else max(courses, default=0) + 1
        if not 0 <= cid < 256:
            sys.exit("授業IDは 0〜255 です。")
        if cid in courses:
            sys.exit(f"ID {cid} は既に「{courses[cid]}」に使われています。")
        courses[cid] = a.name
        save_courses(courses)
        print(f"ID {cid} = {a.name} を {COURSES_FILE} に登録しました。")
    else:
        if not courses:
            print(f"{COURSES_FILE} に登録はまだありません。")
        for cid in sorted(courses):
            print(f"{cid:>3}  {courses[cid]}")


def main():
    p = argparse.ArgumentParser(description="出席カードのコード生成・デコード")
    sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("keygen", help="秘密鍵を作成")
    g = sp.add_parser("generate", help="カード用CSVを生成")
    g.add_argument("--date", help="授業日 (YYYY-MM-DD)。省略時は今日。--repeat 使用時は初回の日付")
    g.add_argument("--repeat", type=int, default=1, help="何回分作るか（既定 1）")
    g.add_argument("--interval", type=int, default=7, help="回と回の間隔の日数（既定 7＝毎週）")
    g.add_argument("--merge", action="store_true", help="複数回分を1つのCSVにまとめる")
    g.add_argument("--no-date", action="store_true",
                   help="日付なしカード（発言カードなど）を作る")
    g.add_argument("--count", type=int, default=100, help="枚数")
    g.add_argument("--start", type=int, default=1, help="開始番号")
    g.add_argument("--course", default="0",
                   help=f"授業ID (0-255) または {COURSES_FILE} に登録した授業名")
    g.add_argument("--out")
    d = sp.add_parser("decode", help="フォーム回答CSVをデコード")
    d.add_argument("responses")
    d.add_argument("--column", help="コードが入った列名（省略時は自動検出）")
    d.add_argument("--out")
    c = sp.add_parser("check", help="コード1つを確認")
    c.add_argument("code")
    co = sp.add_parser("course", help=f"授業IDと授業名の対応表 ({COURSES_FILE}) を管理")
    co.add_argument("action", choices=["add", "list"])
    co.add_argument("name", nargs="?", help="授業名（add のとき）")
    co.add_argument("--id", type=int, help="授業ID（省略時は空いている次の番号）")
    a = p.parse_args()
    {"keygen": lambda a: keygen(), "generate": cmd_generate,
     "decode": cmd_decode, "check": cmd_check,
     "course": cmd_course}[a.cmd](a)


if __name__ == "__main__":
    main()
