import { crc32 } from 'node:zlib'

/** The signatures and fixed fields of a zip file, as APPNOTE.TXT names them. */
const localFileHeader = 0x04034b50
const centralDirectoryHeader = 0x02014b50
const endOfCentralDirectory = 0x06054b50
/** Version 2.0: what a stored entry needs to be read. */
const zipVersion = 20
/** No compression. */
const stored = 0
/** 1980-01-01, the earliest date a zip entry holds, in MS-DOS form. */
const earliestDosDate = (1 << 5) | 1

const localHeaderBytes = 30
const centralHeaderBytes = 46
const endRecordBytes = 22

/**
 * A zip file of `files` (name to content), each stored as it is, without compression: enough for a
 * NuGet package in a test, without a zip library.
 */
export function storedZip(files: Readonly<Record<string, string | Buffer>>): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = Buffer.from(name, 'utf8')
		const data = Buffer.from(content)
		const checksum = crc32(data)

		const local = Buffer.alloc(localHeaderBytes)
		local.writeUInt32LE(localFileHeader, 0)
		local.writeUInt16LE(zipVersion, 4)
		local.writeUInt16LE(stored, 8)
		local.writeUInt16LE(earliestDosDate, 12)
		local.writeUInt32LE(checksum, 14)
		local.writeUInt32LE(data.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		locals.push(local, nameBytes, data)

		const central = Buffer.alloc(centralHeaderBytes)
		central.writeUInt32LE(centralDirectoryHeader, 0)
		central.writeUInt16LE(zipVersion, 4)
		central.writeUInt16LE(zipVersion, 6)
		central.writeUInt16LE(stored, 10)
		central.writeUInt16LE(earliestDosDate, 14)
		central.writeUInt32LE(checksum, 16)
		central.writeUInt32LE(data.length, 20)
		central.writeUInt32LE(data.length, 24)
		central.writeUInt16LE(nameBytes.length, 28)
		central.writeUInt32LE(offset, 42)
		centrals.push(central, nameBytes)

		offset += local.length + nameBytes.length + data.length
	}
	const directory = Buffer.concat(centrals)
	const end = Buffer.alloc(endRecordBytes)
	end.writeUInt32LE(endOfCentralDirectory, 0)
	end.writeUInt16LE(Object.keys(files).length, 8)
	end.writeUInt16LE(Object.keys(files).length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, directory, end])
}
