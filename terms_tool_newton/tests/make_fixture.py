"""시험용 소형 약관 PDF를 만듭니다(실제 약관 아님, 구조만 흉내).

구성: 표지 · 목차 · 보통약관(조문, 별표1 지급기준표) · 특약일반사항 · 개별특약(제2-N조, 별표2-1)
· 약관내 인용조문(마지막 쪽은 스캔 이미지). 8쪽 머리글은 일부러 다른 담보명으로 넣어 불일치를 만듭니다.
"""
import pymupdf

W, H = 595.0, 842.0
F = "korea"


def header(page, text):
    page.insert_text((74, 45), text, fontname=F, fontsize=9.5)


def footer(page, n):
    page.insert_text((290, 825), str(n), fontname=F, fontsize=9)


def lines(page, items, y=90, x=71):
    for t in items:
        if isinstance(t, tuple):
            dx, t = t
        else:
            dx = 0
        page.insert_text((x + dx, y), t, fontname=F, fontsize=10)
        y += 18
    return y


def table(page, top, rows, cols):
    """샘플 약관처럼 채움 사각형으로 표를 그립니다(흰 세로 여백 = 열 구분, 진한 가는 띠 = 행 구분)."""
    dark = (0.0, 0.34, 0.44)
    light = (0.76, 0.93, 1.0)
    x0, x1 = cols[0], cols[-1]
    y = top
    ys = [top]
    for r in rows:
        y += 18 * max(len(c.split("\n")) for c in r) + 6
        ys.append(y)
    shape = page.new_shape()
    for i in range(len(rows)):
        shape.draw_rect(pymupdf.Rect(x0, ys[i], x1, ys[i + 1]))
        shape.finish(fill=light, color=None)
    for yy in ys:
        shape.draw_rect(pymupdf.Rect(x0, yy - 0.8, x1, yy + 0.8))
        shape.finish(fill=dark, color=None)
    for cx in cols[1:-1]:
        shape.draw_rect(pymupdf.Rect(cx - 1.5, ys[0] + 1, cx + 1.5, ys[-1] - 1))
        shape.finish(fill=(1, 1, 1), color=None)
    shape.commit()
    for i, r in enumerate(rows):
        for j, cell in enumerate(r):
            yy = ys[i] + 15
            for ln in cell.split("\n"):
                page.insert_text((cols[j] + 5, yy), ln, fontname=F, fontsize=9)
                yy += 18
    return ys[-1]


def build(path, old=False):
    doc = pymupdf.open()
    MAIN = "(무)테스트건강보험"
    COMMON = "특약일반사항"
    RIDER = "R(무)테스트암진단특약(갱신형)"
    LAW = "약관내 인용조문"

    p = doc.new_page(width=W, height=H)  # 1 표지
    p.insert_text((100, 300), "(무)테스트건강보험 약관", fontname=F, fontsize=24)

    p = doc.new_page(width=W, height=H)  # 2 목차
    p.insert_text((85, 80), "약관의 목차", fontname=F, fontsize=20)
    y = 140
    for num, name in (("0003", MAIN), ("0005", COMMON), ("0006", RIDER), ("0009", LAW)):
        p.insert_text((93, y), num, fontname=F, fontsize=12)
        p.insert_text((157, y), name, fontname=F, fontsize=12)
        y += 26
    for extra in ("0004", "0007", "0008"):
        pass
    footer(p, 2)

    p = doc.new_page(width=W, height=H)  # 3 보통약관
    header(p, MAIN)
    lines(p, [
        "제1관 목적 및 용어의 정의",
        "제1조【목적】",
        (5, "이 계약은 보험계약자와 회사 사이에 체결됩니다."),
        "제2조【보험금의 지급사유】",
        (5, "① 회사는 피보험자가 보험기간 중 사망하였을 때 사망보험금(별표1 참조)을 지급합니다."),
        (5, "② 다음 각 호의 경우에도 사망한 것으로 봅니다."),
        (10, "1. 실종선고를 받은 경우"),
        (10, "2. 재난으로 사망한 것으로 통보된 경우"),
        "제3조【보험금을 지급하지 않는 사유】",
        (5, "회사는 다음 중 어느 한 가지로 보험금 지급사유가 발생한 때에는 보험금을 지급하지 않습니다."),
        (10, "1. 피보험자가 고의로 자신을 해친 경우"),
    ])
    footer(p, 3)

    p = doc.new_page(width=W, height=H)  # 4 보통약관 별표1
    header(p, MAIN)
    p.insert_text((76, 80), "별표1 보험금 지급기준표", fontname=F, fontsize=13)
    table(p, 160, [["급부명", "지급사유", "지급금액"],
                   ["사망보험금\n(제2조)", "피보험자가 보험기간 중\n사망하였을 때", "보험가입금액의\n100%"]],
          [73, 155, 420, 525])
    footer(p, 4)

    p = doc.new_page(width=W, height=H)  # 5 특약일반사항
    header(p, COMMON)
    lines(p, [
        "제1-1조【목적】",
        (5, "이 특약은 계약자가 선택하여 가입한 특약의 제2-2조(보험금의 지급사유)에 해당하는 위험을 보장합니다."),
        "제1-2조【용어의 정의】",
        (5, "가. 계약자: 회사와 계약을 체결하고 보험료를 납입할 의무를 지는 사람을 말합니다."),
    ])
    footer(p, 5)

    p = doc.new_page(width=W, height=H)  # 6 개별특약
    header(p, RIDER)
    lines(p, [
        "제1편 일반사항",
        "[특약 일반사항 약관] 제1편 일반사항 제1-1조부터 제1-2조까지를 이 특약 제1편 일반사항으로 합니다.",
        "제2-1조【용어의 정의】",
        (5, "가. 의료기관: 「의료법」 제3조(의료기관)[약관 내 인용조문 참조]에서 정한 기관을 말합니다."),
        "제2-2조【보험금의 지급사유】",
        (5, "회사는 피보험자가 암보장개시일 이후에 암으로 진단확정되었을 때 암진단자금(별표2-1 참조)을"),
        (5, "지급합니다. 다만, 최초계약의 계약일부터 1년 미만 진단확정시 " + ("30%" if old else "50%") + "를 지급합니다."),
        "제2-3조【보험금 지급에 관한 세부규정】",
        (5, "① 제2-1조(용어의 정의) 및 제1-2조(용어의 정의)를 따릅니다."),
        (5, "② 제9조에 따라 처리합니다."),
    ])
    footer(p, 6)

    p = doc.new_page(width=W, height=H)  # 7 개별특약 계속
    header(p, RIDER)
    lines(p, [
        "제2-4조【주계약 약관의 준용】",
        (5, "이 특약에서 정하지 않은 사항에 대하여는 주계약 약관의 규정을 따릅니다."),
    ])
    footer(p, 7)

    p = doc.new_page(width=W, height=H)  # 8 별표2-1, 머리글을 일부러 주계약 이름으로(불일치)
    header(p, MAIN)
    p.insert_text((76, 80), "별표2-1 보험금 지급기준표", fontname=F, fontsize=13)
    table(p, 160, [["급부명", "지급사유", "지급금액"],
                   ["암진단자금\n(제2-2조)", "암보장개시일 이후 암으로\n진단확정되었을 때", "특약보험가입금액의\n100%"]],
          [73, 155, 420, 525])
    footer(p, 8)

    p = doc.new_page(width=W, height=H)  # 9 인용조문
    header(p, LAW)
    lines(p, [
        "1. 「의료법」",
        (8, "제3조(의료기관) ① 이 법에서 의료기관이란 의료인이 의료업을 하는 곳을 말한다."),
        (10, "1. 의원급 의료기관"),
    ])
    footer(p, 9)

    # 10 스캔 쪽: 글자를 그린 이미지만 넣습니다.
    tmp = pymupdf.open()
    tp = tmp.new_page(width=W, height=H)
    tp.insert_text((74, 45), LAW, fontname=F, fontsize=9.5)
    tp.insert_text((71, 120), "2. 「상법」", fontname=F, fontsize=16)
    tp.insert_text((80, 160), "제732조(15세미만자등에 대한 계약의 금지)", fontname=F, fontsize=16)
    pix = tp.get_pixmap(matrix=pymupdf.Matrix(3, 3))
    p = doc.new_page(width=W, height=H)
    p.insert_image(p.rect, pixmap=pix)
    doc.save(path)
    return path


if __name__ == "__main__":
    import sys
    build(sys.argv[1] if len(sys.argv) > 1 else "fixture.pdf")
