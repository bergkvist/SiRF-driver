const SerialPort = require('serialport')
const binary = require('binary')
const { EventEmitter } = require('events')
const messageTypes = require('./messageTypes')
const port = new SerialPort('/dev/ttyUSB0', { baudRate: 4800 })
const readPort = () => new Promise(resolve => port.once('data', data => resolve(data.toString('hex'))))

const messageEmitter = new EventEmitter()

/**
 * All Serial "packets" are shaped like this:
 * +--------+--------+---------+----------+--------+
 * | START  | LENGTH | PAYLOAD | CHECKSUM | END    |
 * +--------+--------+---------+----------+--------+
 * | 0xA0A2 |  2 B   |   (1)   |   2 B    | 0xB0B3 |
 * +--------+--------+---------+----------+--------+
 * 
 * (1) Max payload length: 2¹⁰-1 (< 1023)
 * - Length and checksum are always 2 bytes
 * - Start and end are two bytes, and always the same ones,
 *   as can be seen above.
 */


function command(payload) {
    const data = {
        start: 'a0a2',
        length: Buffer.from(payload, 'hex').length,
        payload,
        checksum: checksum(payload),
        end: 'b0b3'
    }
    return Buffer.from(data.start + data.length + data.payload + data.checksum + data.end, 'hex')
}

function checksum(payload) {
    const bufferPayload = Buffer.from(payload, 'hex')
    let checksum = 0
    for (let i = 0; i < bufferPayload.length; i++) {
        checksum += Number(bufferPayload[i])
        checksum = checksum & (2**15 - 1)
    }
    return `0000${checksum.toString(16)}`.slice(-4)
}

async function * rawMessages() {  /* Excludes start and stop bytes */
    
    const NOT_FOUND = -1
    const START_SEQ = 'a0a2'
    const END_SEQ = 'b0b3'
    
    let message = ''
    while(true) {
        const data = await readPort()
        message += data
        while(true) {
            let start = message.indexOf(START_SEQ)
            let end   = message.indexOf(END_SEQ)
            if (start === NOT_FOUND || end === NOT_FOUND) break
            if (start > end) {
                message = message.substring(start)
            } else if (start < end) {
                yield message.substring(start + START_SEQ.length, end)
                message = message.substring(end + END_SEQ.length)
            }
        }
    }
}

async function * payloads() {
    for await (const message of rawMessages()) {
        const messageLength = message.substring(0, 4)
        const messagePayload = message.substring(4, message.length - 4)
        const messageChecksum = message.substring(message.length - 4)

        const correctLength = (Buffer.from(messagePayload, 'hex').length === parseInt('0x' + messageLength))
        const correctChecksum = (checksum(messagePayload) === messageChecksum)
        
        if (correctLength && correctChecksum) {
            yield messagePayload
        } else {
            console.warn('==============  Checksum/length verification failed!  ===============')
            console.log({messageLength, messagePayload, messageChecksum, correctLength, correctChecksum})
        }
    }
}

function pollSoftwareVersion() {
    return new Promise((resolve, reject) => {
        port.write(command('8400'))

        messageEmitter.once(0x06, response => {
            console.log(response)
            resolve(response)
        })

        setTimeout(() => reject(Error('pollSoftwareVersion: TIMEOUT')), 3000) // 3 second timeout
    })
}


;(async () => {
    for await (const msg of payloads()) {
        const msgId = Buffer.from(msg, 'hex')[0]
        messageEmitter.emit(msgId, msg)

        if (msgId === 2) {
            console.log(binary.parse(Buffer.from(msg, 'hex'))
                .word8lu('id')
                .word32ls('x')
                .word32ls('y')
                .word32ls('z')
                .word16ls('vx')
                .word16ls('vy')
                .word16ls('vz')
                .vars)
        }

        /*
        if (msgId in messageTypes) {
            const name = messageTypes[msgId].name
            console.log(`[${msgId}] ${name}: ${msg}`)
        } else {
            console.log(`[${msgId}] UNKNOWN msgId: ${msg}`)
        }*/
    }
})()


//pollSoftwareVersion().then(msg => console.log('IT WORKED', msg))