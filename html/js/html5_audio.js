window.onload = function() {
    new Visualizer().init();
};
var Visualizer = function() {
    this.file = null, //the current file
    this.fileName = null, //the current file name
    this.audioContext = null,
    this.gain = null,
    this.source = null, //the audio source
    this.infoUpdateId = null, //to store the setTimeout ID and clear the interval
    this.animationId = null,
    this.status = 0, //flag for sound is playing 1 or stopped 0
    this.forceStop = false,
    // Websockets
    this.ws = null,
    this.connected = false,
    this.serverUrl = 'ws://' + location.host + ':8080';
    //this.serverUrl = 'ws://192.168.4.1:8080';
};

Visualizer.prototype = {
    init: function() {
        this._prepareAPI();
        this._addEventListner();
    },
    _prepareAPI: function() {
        //fix browser vender for AudioContext and requestAnimationFrame
        window.AudioContext = window.AudioContext || window.webkitAudioContext || window.mozAudioContext || window.msAudioContext;
        try {
            this.audioContext = new AudioContext();
            this.gain = this.audioContext.createGain();
            this.gain.gain.volume = 1;
        } catch (e) {
            this._updateInfo('!Your browser does not support AudioContext', false, 'warning');
            console.log(e);
        }
    },
    _addEventListner: function() {
        var self = this,
            audioInput = document.getElementById('uploadedFile'),
            volumeSlider = document.getElementById('volume'),
            stopButton = document.getElementById('stop');
        //listen the file upload
        audioInput.onchange = function() {
            //the if statement fixes the file selction cancle, because the onchange will trigger even the file selection been canceled
            if (audioInput.files.length !== 0) {
                //only process the first file
                self.file = audioInput.files[0];
                self.fileName = self.file.name;
                if (self.status === 1) {
                    //the sound is still playing but we upload another file, so set the forceStop flag to true
                    self.forceStop = true;
                };
                document.getElementById('fileWrapper').style.opacity = 1;
                self._updateInfo('Uploading', true, 'info');
                //once the file is ready,start the visualizer
                self._start();
            };
        };
        volumeSlider.onchange = function() {
            var volume = this.value;
            self.gain.gain.value = Math.pow(10, volume);
        };
        stopButton.onclick = function() {
            if (self.source)
                self.source.stop(0);
        };
    },
    _start: function() {
        //read and decode the file into audio array buffer 
        var self = this,
            file = this.file,
            fr = new FileReader();
        fr.onload = function(e) {
            var fileResult = e.target.result;
            var audioContext = self.audioContext;
            if (audioContext === null) {
                return;
            };
            if (self.ws == null) {
              self._updateInfo('Connecting to ESP8266', true, 'info'); 
              self.ws = new WebSocket(self.serverUrl);
              self.ws.onopen = function() {
                  self._updateInfo('ESP8266 connected', false, 'info');
                  self.connected = true;
              };
              self.ws.onclose = function() {
                  self.ws = null;
                  self.connected = false;
              };
              self.ws.onmessage = function(event) {
                  console.log(event.data);
              };
              self.ws.onerror = function(event) {
                  self._updateInfo('WebSocket error', false, 'danger');
                  self.ws = null;
                  self.connected = false;
              };
            }
            self._updateInfo('Decoding the audio', true, 'info');
            audioContext.decodeAudioData(fileResult, function(buffer) {
                self._updateInfo('Decode succussfully,start the visualizer', true, 'info');
                self._visualize(audioContext, buffer);
            }, function(e) {
                self._updateInfo('!Fail to decode the file', false, 'danger');
                console.log(e);
            });
        };
        fr.onerror = function(e) {
            self._updateInfo('!Fail to read the file', false, 'danger');
            console.log(e);
        };
        //assign the file to the reader
        this._updateInfo('Starting read the file', true, 'info');
        fr.readAsArrayBuffer(file);
    },
    _visualize: function(audioContext, buffer) {
        var audioBufferSouceNode = audioContext.createBufferSource(),
            analyser = audioContext.createAnalyser(),
            self = this;
        //connect the source to the analyser
        audioBufferSouceNode.connect(self.gain);
        self.gain.connect(analyser);
        //connect the analyser to the destination(the speaker), or we won't hear the sound
        analyser.connect(audioContext.destination);
        //then assign the buffer to the buffer source node
        audioBufferSouceNode.buffer = buffer;
        //play the source
        if (!audioBufferSouceNode.start) {
            audioBufferSouceNode.start = audioBufferSouceNode.noteOn //in old browsers use noteOn method
            audioBufferSouceNode.stop = audioBufferSouceNode.noteOff //in old browsers use noteOn method
        };
        //stop the previous sound if any
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
        }
        if (this.source !== null) {
            this.source.stop(0);
        }
        audioBufferSouceNode.start(0);
        this.status = 1;
        this.source = audioBufferSouceNode;
        audioBufferSouceNode.onended = function() {
            self._audioEnd(self);
        };
        this._updateInfo('Playing ' + this.fileName, false, 'info');
        document.getElementById('fileWrapper').style.opacity = 0.2;
        this._drawSpectrum(analyser);
    },
    _drawSpectrum: function(analyser) {
        var self = this,
            canvas = document.getElementById('spectrum'),
            cwidth = canvas.scrollWidth,
            cheight = canvas.scrollHeight,
            dimension = (cwidth < cheight) ? cwidth : cheight,
            gap = 4, //gap between blocks
            block = (dimension - (9 * gap)) / 8, // each block size
            binNum = 16, //count of the meters
            fpsInterval = 1000 / 15,  // 15fps
            now, 
            then = Date.now(),
            elapse,
            startTime = then;
            ctx = canvas.getContext('2d');
        var drawMeter = function() {
            var array = new Uint8Array(analyser.frequencyBinCount),
                colormap = ["#ff2900", "#ffe700", "#5aff00", "#00ff84", "#00d6ff", "#0018ff", "#ad00ff", "#ff008c"],
                colormap_bin = [[0xff, 0x29, 0x00],[0xff, 0xe7, 0x00], [0x5a, 0xff, 0x00], [0x00, 0xff, 0x84], [0x00, 0xd6, 0xff], [0x00, 0x18, 0xff], [0xad, 0x00, 0xff], [0xff, 0x00, 0x8c]];
                spectrum = [[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0]],
                cmd = new Uint8Array(192);
            now = Date.now();
            elapse = now - then;
            if (elapse > fpsInterval) {
                analyser.getByteFrequencyData(array);
                ctx.clearRect(0, 0, cwidth, cheight);
                for (var i = 0; i < 8; i++) {
                    for (var j = 0; j < 8; j++) {
                        spectrum[i][j] = 0;
                    }
                }
                if (self.status == 0) {
                    cancelAnimationFrame(self.animationId); //since the sound is top and animation finished, stop the requestAnimation to prevent potential memory leak,THIS IS VERY IMPORTANT!
                    return;
                };
                var step = Math.round(array.length / binNum); //sample limited data from the total array
                for (var i = 0; i < 8; i++) {
                    var value = 0;
                    for (var j = 0; j < step; ++j) {
                        if (array[(i + 1) * step + j] > value)
                            value = array[(i + 1) * step + j]; 
                    }
                    value = value / 31; // some scale
                    if (value > 7) value = 7;
                    for (var j = 0; j <= value; ++j)
                        spectrum[i][j] = value;
                }
                // Drawing blocks and build command
                for (var i = 0; i < 8; i++) {
                    var xstart = i * (block + gap) + gap;
                    for (var j = 0; j < 8; j++) {
                        if (spectrum[i][j] != 0) {
                            cmd[(i * 8 + j) * 3] = colormap_bin[i][1] >> 2;
                            cmd[(i * 8 + j) * 3 + 1] = colormap_bin[i][0] >> 2;
                            cmd[(i * 8 + j) * 3 + 2] = colormap_bin[i][2] >> 2;
                            ctx.fillStyle = colormap[i];
                            ctx.fillRect(xstart, gap + (7 - j) * (block + gap), block, block);
                        } else {
                            cmd[(i * 8 + j) * 3] = 0;
                            cmd[(i * 8 + j) * 3 + 1] = 0;
                            cmd[(i * 8 + j) * 3 + 2] = 0;
                        }
                  }
                }
                if (self.connected && self.ws) {
                    self.ws.send(cmd);
                }
                then = now - (elapse % fpsInterval);
            }
            self.animationId = requestAnimationFrame(drawMeter);
        }
        // Set canvas size according to style sheet
        canvas.width = cwidth;
        canvas.height = cheight;
        this.animationId = requestAnimationFrame(drawMeter);
    },
    _audioEnd: function(instance) {
        if (this.connected && this.ws) {
            var cmd = new Uint8Array(192);
            for (var i = 0; i < 192; ++i)
              cmd[i] = 0;
              this.ws.send(cmd);
            //this.ws.close();
        }
        if (this.forceStop) {
            this.forceStop = false;
            this.status = 1;
            return;
        };
        this.status = 0;
        document.getElementById('fileWrapper').style.opacity = 1;
        document.getElementById('uploadedFile').value = '';
        this._updateInfo(null, false, 'success');
    },
    _updateInfo: function(message, processing, type) {
        var infoBar = document.getElementById('alert_placeholder'),
            dots = '...',
            i = 0,
            self = this;
		    if (message == null)
            infoBar.hidden = true;
		    else
			      infoBar.hidden = false;
        infoBar.innerHTML = '<div class="alert alert-' + type + '"><span>' + message + '</span></div>';
        if (this.infoUpdateId !== null) {
            clearTimeout(this.infoUpdateId);
        };
        if (processing) {
            //animate dots at the end of the info text
            var animateDot = function() {
                if (i > 3) {
                    i = 0
                };
                infoBar.innerHTML = '<div class="alert alert-' + type + '"><span>' + message + dots.substring(0, i++) + '</span></div>';
                self.infoUpdateId = setTimeout(animateDot, 250);
            }
            this.infoUpdateId = setTimeout(animateDot, 250);
        };
    }
}