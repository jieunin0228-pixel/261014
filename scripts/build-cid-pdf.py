"""비내장 한글 CID 글꼴(UniKS-UCS2-H)을 쓰는 샘플 PDF를 만듭니다.
실제 보험사 약관 PDF 중 이런 글꼴을 쓰는 경우가 있어, 문자표(CMap) 없이 읽으면 글자가 깨지는지 점검하는 용도입니다.
실행: python3 scripts/build-cid-pdf.py <출력.pdf>   (reportlab 필요)"""
import sys
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(UnicodeCIDFont('HYSMyeongJo-Medium'))
lines = [
    '수술비보장 특별약관',
    '제1조(보험금의 지급사유)',
    '① 회사는 피보험자가 수술을 받은 경우 다음의 보험금을 지급합니다.',
    '1. 질병 또는 재해로 인하여 수술을 받은 경우: 수술보험금',
    '제2조(보험금의 지급금액)',
    '① 수술보험금은 가입금액의 10%를 지급합니다.',
]
c = canvas.Canvas(sys.argv[1], pagesize=A4)
c.setFont('HYSMyeongJo-Medium', 11)
y = 800
for line in lines:
    c.drawString(60, y, line)
    y -= 20
c.save()
