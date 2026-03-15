Third-Party Notices
===================

This project includes protocol implementation work informed by the following
third-party project:

1. kappanhang
   - Source: https://github.com/nonoo/kappanhang
   - Authors: Norbert Varga HA2NON, Akos Marton ES1AKOS
   - License: MIT

OrbitDeck's IC-705 Wi-Fi transport in
`app/radio/icom_udp.py` is an original Python implementation, but it adapts
substantial packet-flow and session-setup logic from kappanhang's MIT-licensed
Go implementation, including the control/login/auth/serial-audio request flow.

2. networkICOM
   - Source: https://github.com/mark-erbaugh/networkICOM
   - Author: Mark Erbaugh
   - License: no explicit license file was present in the referenced source at
     the time of implementation review

OrbitDeck's IC-705 Wi-Fi transport was also validated and reshaped using the
packet analysis and control/ConnInfo/serial sequencing documented in
networkICOM. No networkICOM source code was copied into OrbitDeck; it was used
as a behavioral and packet-layout reference only.

3. icom-lan
   - Source: https://github.com/morozsm/icom-lan
   - Author: morozsm
   - License: MIT

OrbitDeck's IC-705 Wi-Fi transport also adopts ideas validated in icom-lan's
MIT-licensed Python implementation, especially around ConnInfo local-port
advertisement, status-derived CI-V/audio port handling, and reconnect hygiene.

MIT License
-----------

Copyright (c) 2020 Norbert Varga HA2NON, Akos Marton ES1AKOS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Additional MIT-licensed reference:

Copyright (c) 2026 morozsm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
