// 棋子 SVG 渲染：使用实心 Unicode 棋子字形，按颜色填充/描边，跨平台一致。
export const GLYPH = {
  1: '♟', // 兵 pawn
  2: '♞', // 马 knight
  3: '♝', // 象 bishop
  4: '♜', // 车 rook
  5: '♛', // 后 queen
  6: '♚', // 王 king
};

export function pieceSVG(type, color) {
  const g = GLYPH[type] || '?';
  const fill = color === 0 ? '#f7f7f3' : '#2a2f36';
  const stroke = color === 0 ? '#3a3a3a' : '#07090c';
  return (
    `<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">` +
    `<text x="50" y="57" text-anchor="middle" dominant-baseline="central" ` +
    `font-size="82" font-family="Georgia, 'Times New Roman', serif" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="2.4">${g}</text></svg>`
  );
}

export function pieceGlyph(type, color) {
  const fill = color === 0 ? '#f7f7f3' : '#2a2f36';
  return `<span style="color:${fill}">${GLYPH[type]}</span>`;
}
