/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { disposeAll } from 'coc.nvim'
import stream from 'stream'
import { Disposable, Emitter } from 'vscode-languageserver-protocol'

const DefaultSize = 8192
const ContentLength = 'Content-Length: '
const ContentLengthSize: number = Buffer.byteLength(ContentLength, 'utf8')
const Blank: number = Buffer.from(' ', 'utf8')[0]
const BackslashR: number = Buffer.from('\r', 'utf8')[0]
const BackslashN: number = Buffer.from('\n', 'utf8')[0]

class ProtocolBuffer {
  private index = 0
  private buffer: Buffer = Buffer.allocUnsafe(DefaultSize)

  public append(data: string | Buffer): void {
    let toAppend: Buffer | null = null
    if (Buffer.isBuffer(data)) {
      toAppend = data as Buffer
    } else {
      toAppend = Buffer.from(data, 'utf8')
    }
    if (this.buffer.length - this.index >= toAppend.length) {
      toAppend.copy(this.buffer, this.index, 0, toAppend.length)
    } else {
      let newSize =
        (Math.ceil((this.index + toAppend.length) / DefaultSize) + 1) *
        DefaultSize
      if (this.index === 0) {
        this.buffer = Buffer.allocUnsafe(newSize)
        toAppend.copy(this.buffer, 0, 0, toAppend.length)
      } else {
        this.buffer = Buffer.concat(
          [this.buffer.slice(0, this.index), toAppend],
          newSize
        )
      }
    }
    this.index += toAppend.length
  }

  public tryReadContentLength(): number {
    let result = -1
    let current = 0
    // we are utf8 encoding...
    while (
      current < this.index &&
      (this.buffer[current] === Blank ||
        this.buffer[current] === BackslashR ||
        this.buffer[current] === BackslashN)
    ) {
      current++
    }
    if (this.index < current + ContentLengthSize) {
      return result
    }
    current += ContentLengthSize
    let start = current
    while (current < this.index && this.buffer[current] !== BackslashR) {
      current++
    }
    if (
      current + 3 >= this.index ||
      this.buffer[current + 1] !== BackslashN ||
      this.buffer[current + 2] !== BackslashR ||
      this.buffer[current + 3] !== BackslashN
    ) {
      return result
    }
    let data = this.buffer.toString('utf8', start, current)
    result = parseInt(data, 10)
    this.buffer = this.buffer.slice(current + 4)
    this.index = this.index - (current + 4)
    return result
  }

  public tryReadContent(length: number): string | null {
    if (this.index < length) {
      return null
    }
    let result = this.buffer.toString('utf8', 0, length)
    let sourceStart = length
    while (
      sourceStart < this.index &&
      (this.buffer[sourceStart] === BackslashR ||
        this.buffer[sourceStart] === BackslashN)
    ) {
      sourceStart++
    }
    this.buffer.copy(this.buffer, 0, sourceStart)
    this.index = this.index - sourceStart
    return result
  }
}

export interface ICallback<T> {
  (data: T): void // tslint:disable-line
}

export class Reader<T> implements Disposable {
  private readonly buffer: ProtocolBuffer = new ProtocolBuffer()
  private nextMessageLength = -1
  private disposables: Disposable[] = []

  private readonly _onError = new Emitter<Error>()
  public readonly onError = this._onError.event

  private readonly _onData = new Emitter<T>()
  public readonly onData = this._onData.event

  public constructor(readable: stream.Readable) {
    const onData = (data: Buffer) => {
      this.onLengthData(data)
    }
    readable.on('data', onData)

    this.disposables.push({
      dispose: () => {
        readable.off('data', onData)
      }
    })
    this.disposables.push(this._onError)
    this.disposables.push(this._onData)
  }

  private onLengthData(data: Buffer): void {
    try {
      this.buffer.append(data)
      while (true) {
        if (this.nextMessageLength === -1) {
          this.nextMessageLength = this.buffer.tryReadContentLength()
          if (this.nextMessageLength === -1) {
            return
          }
        }
        const msg = this.buffer.tryReadContent(this.nextMessageLength)
        if (msg === null) {
          return
        }
        this.nextMessageLength = -1
        const json = JSON.parse(msg)
        this._onData.fire(json)
      }
    } catch (e) {
      this._onError.fire(e)
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
