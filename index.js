/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2020, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */
const H_CLK = 120000000;
const C_CLK = 48000000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const MODEM_CONTROL_DTR_ENABLE = 0x0101;
const MODEM_CONTROL_DTR_DISABLE = 0x0100;
const MODEM_CONTROL_RTS_ENABLE = 0x0202;
const MODEM_CONTROL_RTS_DISABLE = 0x0200;

const RESET_REQUEST = 0;
const MODEM_CONTROL_REQUEST = 1;

const RESET_ALL = 0;


function FTDIToClkbits(baud, clk, clkDiv) {
    const fracCode = [0, 3, 2, 4, 1, 5, 6, 7];
    let bestBaud = 0;
    let divisor;
    let bestDivisor;
    let encodedDivisor;

    if (baud >= clk / clkDiv) {
        encodedDivisor = 0;
        bestBaud = clk / dlkDiv;
    } else if (baud >= clk / (clkDiv + clkDiv / 2)) {
        encodedDivisor = 1;
        bestBaud = clk / (clkDiv + clkDiv / 2);
    } else if (baud >= clk / (2 * clkDiv)) {
        encodedDivisor = 2;
        bestBaud = clk / (2 * clkDiv);
    } else {
        divisor = clk * 16 / clkDiv / baud;
        if (divisor & 1) {
            bestDivisor = divisor / 2 + 1;
        } else {
            bestDivisor = divisor / 2;
        }

        if (bestDivisor > 0x20000) {
            bestDivisor = 0x1ffff;
        }

        bestBaud = clk * 16 / clkDiv / bestDivisor;

        if (bestBaud & 1) {
            bestBaud = bestBaud / 2 + 1;
        } else {
            bestBaud = bestBaud / 2;
        }

        encodedDivisor = (bestDivisor >> 3) | (fracCode[bestDivisor & 0x7] << 14);
    }

    return [bestBaud, encodedDivisor];
}

function FTDIConvertBaudrate(baud) {
    let bestBaud;
    let encodedDivisor;
    let value;
    let index;

    if (baud <= 0) {
        throw new Error('Baud rate must be > 0');
    }

    [bestBaud, encodedDivisor] = FTDIToClkbits(baud, C_CLK, 16);

    value = encodedDivisor & 0xffff;
    index = encodedDivisor >> 16;

    return [bestBaud, value, index];
}

export default class ftdi extends EventTarget {
    dtr = true
    rts = true

    constructor(device, options) {
        super();
        const self = this;

        (async () => {
            if (device == null) {
                throw new Error('Could not find device');
            }

            await device.open();
            console.log('Opened:', device.opened);

            if (device.configuration === null) {
                console.log('selectConfiguration');
                await device.selectConfiguration(1);
            }
            await device.claimInterface(0);
            await device.selectConfiguration(1);
            await device.selectAlternateInterface(0, 0);

            const [baud, value, index] = FTDIConvertBaudrate(options.baudRate);
            console.log('Setting baud rate to', baud);
            const result = await device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: 3,
                value,
                index,
            });

            self.device = device;
            self.isClosing = false;

            // reset all
            const resetResult = await device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: RESET_REQUEST,
                value: RESET_ALL,
                index: 1 // ?? port+1
            })
            console.debug("reset result: ", resetResult)

            // set dtr, rts
            const controlLineResult = await device.controlTransferOut({
                requestType: 'vendor',
                recipient: 'device',
                request: MODEM_CONTROL_REQUEST,
                value: (this.dtr ? MODEM_CONTROL_DTR_ENABLE : MODEM_CONTROL_DTR_DISABLE) |
                    (this.rts ? MODEM_CONTROL_RTS_ENABLE : MODEM_CONTROL_RTS_DISABLE),
                index: 1, // ?? port+1
            })
            console.debug("set control lines result: ", controlLineResult)


            this.device.transferIn(1, 64); // flush buffer
            self.readLoop();
            self.dispatchEvent(new Event('ready'));
        })().catch((error) => {
            console.log('Error during FTDI setup:', error);
            self.dispatchEvent(new CustomEvent('error', {
                detail: error,
            }));
        });
    }

    async readLoop() {
        let result;

        try {
            result = await this.device.transferIn(1, 64);
        } catch (error) {
            if (error.message.indexOf('LIBUSB_TRANSFER_NO_DEVICE')) {
                console.log('Device disconnected');
                this.isClosing = true; // flag this so we don't keep hitting this error
                this.dispatchEvent(new Event('disconnected'));
            } else {
                console.log('Error reading data:', error);
            }
        }
        ;

        if (result && result.data && result.data.byteLength && result.data.byteLength > 2) {
            console.log(`Received ${result.data.byteLength - 2} byte(s).`);
            const uint8buffer = new Uint8Array(result.data.buffer);
            this.dispatchEvent(new CustomEvent('data', {
                detail: uint8buffer.slice(2),
            }));
        }

        if (!this.isClosing && this.device.opened) {
            this.readLoop();
        }
    };

    async read() {
        const {data: {buffer: dataBuffer, byteLength: bytesRead}} = await this.device.transferIn(1, 64);
        const uint8buffer = new Uint8Array(dataBuffer);

        if (bytesRead === 2) {
            return this.read();
        }

        return {bytesRead: bytesRead - 2, data: uint8buffer.slice(2)};
    }

    async writeAsync(buffer) {
        return await this.device.transferOut(2, buffer);
    }

    write(data, cb) {
        this.writeAsync(data).then(() => {
            cb();
        }, err => cb(err));
    }

    async closeAsync() {
        this.isClosing = true;
        this.dispatchEvent(new Event('disconnected'));
        try {
            console.log('Sending EOT');
            await this.writeAsync([0x04]);
            await delay(2000); // wait for send/receive to complete
            await this.device.releaseInterface(0);
            await this.device.close();
            console.log('Closed device');
        } catch (err) {
            console.log('Error:', err);
        }
    }

    close(cb) {
        (async () => {
            await this.closeAsync();
            return cb();
        })();
    }
}
