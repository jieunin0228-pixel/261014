"""시험용 합성 약관 PDF를 만듭니다: python tests/make_fixture.py

실제 상품과 무관한 가상 약관이며, 다음 형태를 일부러 넣었습니다.
 - 책 앞 목차 쪽(쪽번호가 앞에 오는 형식), 머리글·바닥글·인쇄 쪽번호(PDF 쪽과 1쪽 차이)
 - 띄어쓰기 공백 문자가 없고 글자 간격으로만 띄어 쓴 줄
 - 2단 편집 쪽, 빠진 조문 번호(제5조 없음), 해설 상자
 - 선이 그려진 별표 표, 글자가 없는 스캔(이미지) 쪽
"""
import os

import pymupdf

FONT = "korea"
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "sample_terms.pdf")


def put(page, x, y, text, size=10.0):
    page.insert_text((x, y), text, fontname=FONT, fontsize=size)


def put_spaced(page, x, y, text, size=10.0):
    """공백 문자 없이 단어마다 x 좌표를 띄워 씁니다(공백이 없는 PDF 흉내)."""
    font = pymupdf.Font("korea")
    for word in text.split(" "):
        page.insert_text((x, y), word, fontname=FONT, fontsize=size)
        x += font.text_length(word, fontsize=size) + size * 0.45


def header_footer(page, printed):
    put(page, 330, 40, "가상건강보험 약관", 9)
    put(page, 292, 815, str(printed), 9)


def build(path=OUT):
    doc = pymupdf.open()
    # 1쪽: 표지 겸 목차 (인쇄 쪽번호 없음)
    p = doc.new_page()
    put(p, 70, 90, "약관의 목차", 16)
    put(p, 90, 140, "0001 가상건강보험 주계약")
    put(p, 90, 160, "0003 가상암진단특약")
    put(p, 90, 180, "0005 약관내 인용조문")

    # 2쪽(인쇄 1쪽): 주계약 본문, 공백 없는 줄 포함
    p = doc.new_page()
    header_footer(p, 1)
    put(p, 70, 80, "가상건강보험 주계약 약관", 13)
    put(p, 70, 110, "제1관 목적 및 용어의 정의", 11)
    put(p, 70, 135, "제1조【목적】", 11)
    put_spaced(p, 81, 155, "이 계약은 피보험자에게 보험금을 지급하는 것을 목적으로 합니다.")
    put(p, 70, 180, "제2조【용어의 정의】", 11)
    put(p, 81, 200, "이 계약에서 사용되는 용어의 뜻은 다음과 같습니다.")
    put(p, 81, 218, "가. 보험기간: 계약에 따라 보장을 받는 기간")
    put(p, 81, 236, "나. 진단확정: 병리 전문의가 내린 진단")
    put(p, 70, 262, "제3조【보험금의 지급사유】", 11)
    put(p, 81, 282, "① 회사는 다음 각 호의 사유가 생긴 때에 보험금을 지급합니다.")
    put(p, 92, 300, "1. 피보험자가 보험기간 중 사망하였을 때")
    put(p, 92, 318, "2. 피보험자가 보험기간 중 장해상태가 되었을 때")
    put(p, 81, 336, "② 제1항 제2호의 장해지급률은 별표1 장해분류표에 따릅니다. 앞 항도 같습니다.")
    # 해설 상자
    p.draw_rect(pymupdf.Rect(88, 350, 520, 400), color=(0, 0, 0), width=0.8)
    p.draw_line((88, 370), (520, 370), color=(0, 0, 0), width=0.5)
    put(p, 95, 364, "【설명】")
    put(p, 95, 388, "① 이 줄은 해설 상자 안의 예시이며 항이 아닙니다.")
    put(p, 81, 420, "③ 회사는 제9조에 따른 서류를 받은 날부터 3영업일 이내에 지급합니다.")

    # 3쪽(인쇄 2쪽): 2단 편집, 제5조 누락
    p = doc.new_page()
    header_footer(p, 2)
    left = ["제4조【보험금의 청구】", "① 보험수익자는 다음의", "서류를 제출합니다.", "1. 청구서", "2. 진단서",
            "② 제1항의 서류는", "원본이어야 합니다."]
    right = ["제6조【계약의 소멸】", "① 피보험자가 사망한", "경우 계약은 소멸합니다.", "② 제4조에 따라 청구한",
             "보험금은 지급합니다.", "제7조【준거법】", "이 계약은 국내법을 따릅니다."]
    for k, t in enumerate(left):
        put(p, 70 if t.startswith("제") else 80, 90 + k * 20, t, 10)
    for k, t in enumerate(right):
        put(p, 310 if t.startswith("제") else 320, 90 + k * 20, t, 10)

    # 4쪽(인쇄 3쪽): 특약 시작 + 별표 표(선 있음)
    p = doc.new_page()
    header_footer(p, 3)
    put(p, 70, 80, "가상암진단특약 약관", 13)
    put(p, 70, 110, "제1조【보험금의 지급사유】", 11)
    put(p, 81, 130, "회사는 암으로 진단확정된 때 별표1의 금액을 지급합니다. 주계약 제3조를 준용합니다.")
    put(p, 70, 170, "별표1 보험금 지급기준표", 12)
    xs, ys = [70, 200, 420, 520], [190, 210, 230, 250]
    for x in xs:
        p.draw_line((x, ys[0]), (x, ys[-1]), color=(0, 0, 0), width=0.8)
    for y in ys:
        p.draw_line((xs[0], y), (xs[-1], y), color=(0, 0, 0), width=0.8)
    cells = [["급부명", "지급사유", "지급금액"], ["암진단자금", "암으로 진단확정", "1,000만원"],
             ["소액암진단자금", "소액암으로 진단확정", "200만원"]]
    for r, row in enumerate(cells):
        for c, t in enumerate(row):
            put(p, xs[c] + 4, ys[r] + 14, t, 9)

    # 5쪽(인쇄 4쪽): 스캔 쪽(글자 없이 이미지만)
    p = doc.new_page()
    header_footer(p, 4)
    tmp = pymupdf.open()
    tp = tmp.new_page()
    put(tp, 70, 100, "제2조【스캔된 조문】 이 쪽은 이미지입니다.", 12)
    pix = tp.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5))
    p.insert_image(pymupdf.Rect(40, 60, 555, 780), pixmap=pix)

    # 6쪽(인쇄 5쪽): 부속 자료
    p = doc.new_page()
    header_footer(p, 5)
    put(p, 70, 80, "약관내 인용조문", 13)
    put(p, 70, 110, "상법 제651조(고지의무위반으로 인한 계약해지) 본문", 10)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    doc.save(path)
    return path


if __name__ == "__main__":
    print(build())
