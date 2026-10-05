/**
 * 验证侧 XLSX 回读器（只读，不依赖 DOMParser）。
 * 生产侧 buildXlsxBlob 写出的是 stored（不压缩）ZIP + 内联字符串工作表，
 * 这里按同一格式契约逐单元格读回，并保留「数值格 / 文本格」类型信息，
 * 用来断言导出文件里数字与文本不混、特殊字符单元格无损。
 */

export type ReadCell = { value: string; isNumber: boolean }
export type ReadSheet = { name: string; rows: ReadCell[][] }

function unescapeXml(text: string): string {
  // 顺序敏感：先还原具名实体，最后还原 &amp;（否则 &amp;lt; 会被错解成 <）
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 解包 stored ZIP（生产侧写入器不压缩；若未来改成 deflate 这里会直接报错而不是静默错读） */
export async function unzipStored(blob: Blob): Promise<Map<string, string>> {
  const data = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const files = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= data.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameLength))
    if (method !== 0) throw new Error(`验证侧只支持 stored ZIP，${name} 使用了压缩方式 ${method}`)
    const start = offset + 30 + nameLength + extraLength
    const content = new TextDecoder().decode(data.subarray(start, start + compressedSize))
    files.set(name, content)
    offset = start + compressedSize
  }
  if (files.size === 0) throw new Error('不是有效的 ZIP/XLSX（未找到本地文件头）')
  return files
}

function columnIndex(letters: string): number {
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function parseSheetXml(xml: string): ReadCell[][] {
  const rows: ReadCell[][] = []
  const rowPattern = /<row r="(\d+)">([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const rowNumber = Number(rowMatch[1])
    const body = rowMatch[2]
    const cells: ReadCell[] = []
    const cellPattern =
      /<c r="([A-Z]+)\d+"(?:\s+t="(inlineStr)")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)<\/c>/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellPattern.exec(body)) !== null) {
      const column = columnIndex(cellMatch[1])
      const isInline = cellMatch[2] === 'inlineStr'
      const raw = isInline ? (cellMatch[4] ?? '') : (cellMatch[3] ?? '')
      const cell: ReadCell = { value: isInline ? unescapeXml(raw) : raw, isNumber: !isInline }
      while (cells.length < column) cells.push({ value: '', isNumber: false })
      cells[column] = cell
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = cells
  }
  return rows
}

/** 读回 buildXlsxBlob 的产物：工作表名（按顺序）+ 逐格内容与类型 */
export async function readXlsxBlob(blob: Blob): Promise<ReadSheet[]> {
  const files = await unzipStored(blob)
  const workbook = files.get('xl/workbook.xml')
  if (!workbook) throw new Error('XLSX 缺少 xl/workbook.xml')
  const names: string[] = []
  const sheetPattern = /<sheet name="([^"]*)"[^>]*\/>/g
  let sheetMatch: RegExpExecArray | null
  while ((sheetMatch = sheetPattern.exec(workbook)) !== null) names.push(unescapeXml(sheetMatch[1]))

  return names.map((name, index) => {
    const xml = files.get(`xl/worksheets/sheet${index + 1}.xml`)
    if (!xml) throw new Error(`XLSX 缺少工作表 ${index + 1}（${name}）`)
    return { name, rows: parseSheetXml(xml) }
  })
}

/** 把期望行（string | number）规整成与回读结果可比较的形态：'' 视为空单元格 */
export function expectRows(rows: (string | number)[][]): ReadCell[][] {
  return rows.map((row) =>
    row.map((cell) =>
      typeof cell === 'number'
        ? { value: String(cell), isNumber: true }
        : { value: cell, isNumber: false }
    )
  )
}

/**
 * 工作表签名：去掉每行尾部空单元格（写入器会省略空格，回读侧补位），
 * 数值格加 # 前缀，行 / 列用控制字符连接。签名相等 ⇔ 逐格内容与类型一致。
 */
export function sheetSignature(rows: ReadCell[][]): string {
  return rows
    .map((row) => {
      const trimmed = [...row]
      while (trimmed.length > 0 && !trimmed[trimmed.length - 1].isNumber && trimmed[trimmed.length - 1].value === '') {
        trimmed.pop()
      }
      return trimmed.map((cell) => (cell.isNumber ? `#${cell.value}` : cell.value)).join('\u0001')
    })
    .join('\u0002')
}
