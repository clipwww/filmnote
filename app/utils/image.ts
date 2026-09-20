/**
 * 海報上傳前的縮圖。一定要在瀏覽器縮：bucket 的 `file_size_limit` 是 **2 MiB**，而手機隨手拍
 * 就 3–5 MB ⇒ 不縮的話使用者會在按下上傳之後才被拒絕，而那時他已經完成整個表單。
 * **限制要在使用者付出成本之前生效，不是之後。**
 */
/*
 * 長邊 500px 是 `SCREENS §11` 定的（票根卡上的海報最寬 56px、作品頁側欄 220px，500 已涵蓋 2× DPR）。
 * 輸出一律 JPEG：bucket 只收 jpeg/png/webp，而統一 JPEG 的理由是大小可預期
 * （PNG 的照片會比原檔更大），而海報是照片類內容。
 */

export const POSTER_MAX_EDGE = 500
export const POSTER_MIME = 'image/jpeg'
/** 與 bucket 的 file_size_limit 一致。超過就是伺服器會擋的那條線。 */
export const POSTER_MAX_BYTES = 2 * 1024 * 1024

export interface ResizedImage {
  blob: Blob
  width: number
  height: number
  /** 預覽用的 object URL。**呼叫端負責 revoke**，否則整頁的記憶體會一直長。 */
  previewUrl: string
}

/**
 * 把圖片縮到長邊 `POSTER_MAX_EDGE`，回傳 JPEG blob 與預覽 URL。
 *
 * 比原圖小的圖**不放大**——放大只會製造模糊，而 500px 是上限不是目標。
 */
export async function resizePoster(file: File): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx)
      throw new Error('這個瀏覽器沒有辦法處理圖片')
    // JPEG 沒有透明通道，先鋪白底，否則透明 PNG 會變成黑塊
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, POSTER_MIME, 0.85))
    if (!blob)
      throw new Error('圖片轉檔失敗')

    return { blob, width, height, previewUrl: URL.createObjectURL(blob) }
  }
  finally {
    bitmap.close()
  }
}
