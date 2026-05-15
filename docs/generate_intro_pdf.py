# -*- coding: utf-8 -*-
"""
生成"手机助手 - 应用功能介绍" PDF 文档
基于三张截图：
  1.png  拖拽 APK 到应用列表区域，松开自动安装
  2.png  点击"浏览"打开应用文档目录（文件浏览器）
  3.png  在 com.tencent.uc 行上右键 → 创建引擎热更目录
"""
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak,
    Table, TableStyle, KeepTogether,
)
from PIL import Image as PILImage

# ---- 字体（微软雅黑） ----
FONT_REG = "MSYH"
FONT_BOLD = "MSYHBD"
pdfmetrics.registerFont(TTFont(FONT_REG, r"C:\Windows\Fonts\msyh.ttc"))
pdfmetrics.registerFont(TTFont(FONT_BOLD, r"C:\Windows\Fonts\msyhbd.ttc"))

DOCS_DIR = Path(__file__).parent
OUT_PDF = DOCS_DIR / "手机助手-应用功能介绍.pdf"


def styled_image(path: Path, max_width_cm: float = 15.5, max_height_cm: float = 11) -> Image:
    """按比例缩放图片，限制最大宽高（厘米）。"""
    with PILImage.open(path) as im:
        w, h = im.size
    max_w = max_width_cm * cm
    max_h = max_height_cm * cm
    ratio = min(max_w / w, max_h / h)
    return Image(str(path), width=w * ratio, height=h * ratio)


def build():
    styles = getSampleStyleSheet()
    base_font_kwargs = dict(fontName=FONT_REG, leading=18)
    style_title = ParagraphStyle(
        "Title", parent=styles["Title"], fontName=FONT_BOLD,
        fontSize=24, leading=32, spaceAfter=10, alignment=1,
        textColor=colors.HexColor("#1677ff"),
    )
    style_subtitle = ParagraphStyle(
        "SubTitle", parent=styles["Normal"], fontName=FONT_REG,
        fontSize=11, leading=16, alignment=1, spaceAfter=18,
        textColor=colors.HexColor("#555555"),
    )
    style_h1 = ParagraphStyle(
        "H1", parent=styles["Heading1"], fontName=FONT_BOLD,
        fontSize=16, leading=24, spaceBefore=14, spaceAfter=8,
        textColor=colors.HexColor("#1677ff"),
    )
    style_h2 = ParagraphStyle(
        "H2", parent=styles["Heading2"], fontName=FONT_BOLD,
        fontSize=13, leading=20, spaceBefore=10, spaceAfter=6,
        textColor=colors.HexColor("#222222"),
    )
    style_body = ParagraphStyle(
        "Body", parent=styles["BodyText"], fontSize=10.5, **base_font_kwargs,
    )
    style_bullet = ParagraphStyle(
        "Bullet", parent=style_body, leftIndent=14, bulletIndent=2,
        spaceBefore=2, spaceAfter=2,
    )
    style_caption = ParagraphStyle(
        "Caption", parent=styles["Italic"], fontName=FONT_REG,
        fontSize=9.5, leading=14, alignment=1, spaceBefore=4, spaceAfter=14,
        textColor=colors.HexColor("#888888"),
    )

    story = []

    # 封面标题
    story.append(Spacer(1, 1 * cm))
    story.append(Paragraph("手机助手 · 应用功能介绍", style_title))
    story.append(Paragraph(
        "Apk Install Helper&nbsp;&nbsp;|&nbsp;&nbsp;桌面端安卓装包与文件管理工具&nbsp;&nbsp;|&nbsp;&nbsp;v0.3.6",
        style_subtitle,
    ))

    # 概览
    story.append(Paragraph("产品概览", style_h1))
    story.append(Paragraph(
        "「手机助手」是一款基于 Electron 构建的桌面端安卓设备管理工具，通过内置 ADB 与已连接设备通讯，"
        "为开发与测试人员提供应用安装、应用文档目录浏览、文件上传下载等常用能力。本文档基于实际界面截图，"
        "介绍三项核心功能。",
        style_body,
    ))

    # 概要信息表
    info_rows = [
        ["所属平台", "Windows / macOS / Linux（Electron）"],
        ["当前版本", "v0.3.6"],
        ["核心能力", "应用列表、拖拽安装、应用文档浏览、引擎热更目录创建"],
        ["典型用户", "客户端研发、测试、运维"],
    ]
    info_table = Table(info_rows, colWidths=[3.5 * cm, 12 * cm])
    info_table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), FONT_REG, 10),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f0f5ff")),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#1677ff")),
        ("FONT", (0, 0), (0, -1), FONT_BOLD, 10),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d9d9d9")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 0.4 * cm))

    # ---------- 功能一：拖拽 APK 安装 ----------
    story.append(PageBreak())
    story.append(Paragraph("功能一 · 拖拽 APK 一键安装", style_h1))
    story.append(Paragraph(
        "在已连接设备的前提下，将一个或多个 <b>.apk</b> 文件从资源管理器直接拖入应用列表区域，"
        "界面会浮现「松开以安装 APK」的视觉引导，松开鼠标后立即开始安装，无需手动点击按钮。",
        style_body,
    ))

    story.append(Paragraph("使用步骤", style_h2))
    for s in [
        "在左侧设备列表选中目标设备（如截图中的 Xiaomi 24129PN74C，Android 16）。",
        "从本地拖动 APK 文件到右侧应用列表区域。",
        "悬停时界面变色并显示「松开以安装 APK」提示。",
        "松开鼠标，自动调用 ADB 安装；安装完成后列表会刷新。",
    ]:
        story.append(Paragraph("• " + s, style_bullet))

    story.append(Paragraph("适用场景", style_h2))
    for s in [
        "调试包、灰度包的快速安装。",
        "批量安装：可一次拖入多个 APK。",
        "替代命令行 <font face='%s'>adb install</font>，降低非技术使用者的门槛。" % FONT_REG,
    ]:
        story.append(Paragraph("• " + s, style_bullet))

    story.append(Spacer(1, 0.3 * cm))
    story.append(KeepTogether([
        styled_image(DOCS_DIR / "1.png"),
        Paragraph("图 1 &nbsp;&nbsp; 拖拽 APK 到应用列表，松开即可安装", style_caption),
    ]))

    # ---------- 功能二：应用文档目录浏览 ----------
    story.append(PageBreak())
    story.append(Paragraph("功能二 · 应用文档目录浏览器", style_h1))
    story.append(Paragraph(
        "在应用列表的每一行右侧，点击「浏览」按钮即可打开当前应用对应的文档目录 "
        "<font face='%s'>/sdcard/Android/data/&lt;包名&gt;</font>。" % FONT_REG +
        "弹出的文件浏览器面板支持上传、下载、删除、新建文件夹，并可在面包屑上直接跳转。",
        style_body,
    ))

    story.append(Paragraph("主要能力", style_h2))
    for s in [
        "<b>面包屑导航</b>：sdcard / Android / data / com.tencent.uc，点击任意一级即可跳转。",
        "<b>双向传输</b>：支持从桌面拖入文件上传，也可勾选远端文件下载到本地。",
        "<b>批量操作</b>：勾选后可批量删除。",
        "<b>新建目录</b>：工具栏「新建文件夹」按钮，配合下文功能三可快速搭好热更目录结构。",
    ]:
        story.append(Paragraph("• " + s, style_bullet))

    story.append(Paragraph("界面要点", style_h2))
    story.append(Paragraph(
        "如图 2 所示，进入「异人之下」（包名 <font face='%s'>com.tencent.uc</font>）的文档目录后，"
        "可以看到运行后自动生成的 <font face='%s'>cache</font> 与 <font face='%s'>files</font> 两个常见子目录，"
        "Unity / U3D 等引擎的可写资源通常存放在 <font face='%s'>files</font> 下。"
        % (FONT_REG, FONT_REG, FONT_REG, FONT_REG),
        style_body,
    ))

    story.append(Spacer(1, 0.3 * cm))
    story.append(KeepTogether([
        styled_image(DOCS_DIR / "2.png"),
        Paragraph("图 2 &nbsp;&nbsp; 点击「浏览」打开应用文档目录，可上传/下载/删除文件", style_caption),
    ]))

    # ---------- 功能三：创建引擎热更目录 ----------
    story.append(PageBreak())
    story.append(Paragraph("功能三 · 一键创建引擎热更目录", style_h1))
    story.append(Paragraph(
        "针对 <b>com.tencent.uc</b> 的特定使用场景，应用列表行支持<b>右键菜单</b>。"
        "在该应用所在行点击鼠标右键，会弹出「创建引擎热更目录」菜单项，单击后自动在设备上创建以下两级目录："
        ,
        style_body,
    ))

    path_table = Table(
        [["目标路径", "/sdcard/Android/data/com.tencent.uc/files/ExtraFiles/arm64-v8a"]],
        colWidths=[3 * cm, 12.5 * cm],
    )
    path_table.setStyle(TableStyle([
        ("FONT", (0, 0), (0, 0), FONT_BOLD, 10),
        ("FONT", (1, 0), (1, 0), FONT_REG, 10),
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#fff7e6")),
        ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#fffbe6")),
        ("TEXTCOLOR", (0, 0), (0, 0), colors.HexColor("#d46b08")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#ffd591")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(path_table)
    story.append(Spacer(1, 0.3 * cm))

    story.append(Paragraph("操作步骤", style_h2))
    for s in [
        "在应用列表中找到「异人之下」（包名 com.tencent.uc）。",
        "在该行任意位置点击鼠标右键。",
        "在弹出的菜单中选择「创建引擎热更目录」。",
        "界面顶部提示「已创建：/sdcard/Android/data/com.tencent.uc/files/ExtraFiles/arm64-v8a」即表示成功。",
    ]:
        story.append(Paragraph("• " + s, style_bullet))

    story.append(Paragraph("设计说明", style_h2))
    for s in [
        "右键菜单仅在 <b>com.tencent.uc</b> 行展示，避免污染其它应用的交互。",
        "底层使用 <font face='%s'>adb shell mkdir -p</font>，即使 files 目录尚未生成也可自动补齐。" % FONT_REG,
        "目录创建后可立即配合「功能二」的文件浏览器上传热更资源到 <font face='%s'>arm64-v8a</font>。" % FONT_REG,
    ]:
        story.append(Paragraph("• " + s, style_bullet))

    story.append(Spacer(1, 0.3 * cm))
    story.append(KeepTogether([
        styled_image(DOCS_DIR / "3.png", max_height_cm=8),
        Paragraph("图 3 &nbsp;&nbsp; com.tencent.uc 行右键 → 「创建引擎热更目录」", style_caption),
    ]))

    # ---------- 结尾 ----------
    story.append(Paragraph("典型工作流", style_h1))
    flow_rows = [
        ["①", "拖拽安装游戏 APK", "无需 adb 命令，松开即装"],
        ["②", "右键创建热更目录", "一键生成 files/ExtraFiles/arm64-v8a"],
        ["③", "浏览并上传热更包", "通过浏览器拖入或点击「上传」"],
        ["④", "启动应用验证", "热更资源就绪，直接进入游戏验证"],
    ]
    flow_table = Table(flow_rows, colWidths=[1 * cm, 5.5 * cm, 9 * cm])
    flow_table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), FONT_REG, 10),
        ("FONT", (0, 0), (0, -1), FONT_BOLD, 12),
        ("FONT", (1, 0), (1, -1), FONT_BOLD, 10),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#1677ff")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fafafa")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e8e8e8")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(flow_table)
    story.append(Spacer(1, 0.6 * cm))

    story.append(Paragraph(
        "<font color='#888888'>— 本文档由项目内置工具基于截图自动生成，"
        "图片来源：应用运行时实拍 1.png / 2.png / 3.png。</font>",
        style_caption,
    ))

    # 页脚
    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT_REG, 8)
        canvas.setFillColor(colors.HexColor("#999999"))
        canvas.drawCentredString(A4[0] / 2, 1 * cm, f"手机助手 · 应用功能介绍   ·   第 {doc.page} 页")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(OUT_PDF),
        pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=1.8 * cm, bottomMargin=1.8 * cm,
        title="手机助手 · 应用功能介绍",
        author="ApkInstallHelper",
    )
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"PDF generated: {OUT_PDF}")


if __name__ == "__main__":
    build()
