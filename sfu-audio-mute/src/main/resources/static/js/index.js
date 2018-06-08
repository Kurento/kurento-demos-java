/*
 * Copyright 2018 Kurento (https://www.kurento.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const ws = new WebSocket('wss://' + location.host + '/sfu-audio-mute');

function StateVars(tag, peer, pc, stream, track, rtpSender, rtpReceiver) {
  this.tag = tag || null;  // <audio> or <video> tag
  this.peer = peer || null;  // kurentoUtils.WebRtcPeer
  this.pc = pc || null;  // RTCPeerConnection
  this.stream = stream || null;  // MediaStream
  this.track = track || null;  // MediaStreamTrack
  this.rtpSender = rtpSender || null;  // RTCRtpSender
  this.rtpReceiver = rtpReceiver || null; // RTCRtpReceiver
}

const talker = new StateVars();
const listener1 = new StateVars();
const listener2 = new StateVars();

const peers = new Map();  // Map<(String)WebRtcEndpoint.Id, (Object)WebRtcPeer>

// UI
let uiState = null;
const UI_IDLE = 0;
const UI_STARTING = 1;
const UI_STARTED = 2;

window.onload = function()
{
  console = new Console();
  console.log("Page loaded");
  uiSetState(UI_IDLE);

  talker.tag = document.getElementById('uiTalkerAudio');
  listener1.tag = document.getElementById('uiListener1Audio');
  listener2.tag = document.getElementById('uiListener2Audio');
}

window.onbeforeunload = function()
{
  console.log("Page unload - Close WebSocket");
  ws.close();
}

function explainUserMediaError(err)
{
  const n = err.name;
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
    return "Missing webcam for required tracks";
  }
  else if (n === 'NotReadableError' || n === 'TrackStartError') {
    return "Webcam is already in use";
  }
  else if (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError') {
    return "Webcam doesn't provide required tracks";
  }
  else if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
    return "Webcam permission has been denied by the user";
  }
  else if (n === 'TypeError') {
    return "No media tracks have been requested";
  }
  else {
    return "Unknown error: " + err;
  }
}

function sendError(message)
{
  console.error(message);

  sendMessage({
    id: 'ERROR',
    message: message,
  });
}

function sendMessage(message)
{
  if (ws.readyState !== ws.OPEN) {
    console.warn("[sendMessage] Skip, WebSocket session isn't open");
    return;
  }

  const jsonMessage = JSON.stringify(message);
  console.log("[sendMessage] message: " + jsonMessage);
  ws.send(jsonMessage);
}

function makePeer(sdpOffer, webRtcEpId)
{
  console.log("[makePeer] Make WebRtcPeerSendonly, webRtcEpId: " + webRtcEpId);

  const options = {
    localVideo: talker.tag,
    remoteVideo: null,
    mediaConstraints: { audio: true, video: false },
    onicecandidate: (candidate) => sendMessage({
      id: 'ADD_ICE_CANDIDATE',
      webRtcEpId: webRtcEpId,
      candidate: candidate,
    }),
    onnegotiationneeded: (ev) => console.log("[talker.WebRtcPeer.onnegotiationneeded] NOOP, webRtcEpId: "
        + webRtcEpId),
  };

  talker.peer = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options,
      function(err)
  {
    if (err) {
      sendError("[talker.WebRtcPeer] Error: " + explainUserMediaError(err));
      stop();
      return;
    }

    console.log("[talker.WebRtcPeer] Created");

    peers.set(webRtcEpId, talker.peer);
    talker.pc = talker.peer.peerConnection;
    talker.stream = talker.tag.srcObject;
    talker.track = talker.stream.getAudioTracks()[0];
    talker.rtpSender = talker.pc.getSenders().find(
        (s) => s.track === talker.track);

    sendMessage({
      id: 'WEBRTCPEER_READY',
      webRtcEpId: webRtcEpId,
    });

    console.log("[talker.WebRtcPeer] Process SDP Offer");
    talker.peer.processOffer(sdpOffer, (err, sdpAnswer) => {
      if (err) {
        sendError("[talker.WebRtcPeer.processOffer] Error: " + err);
        stop();
        return;
      }

      // Only after setting the new track, add a handler for onnegotiationneeded
      talker.pc.onnegotiationneeded = (ev) => {
        console.log("[handleMakeTalker.WebRtcPeerSendonly.onnegotiationneeded] Generate SDP Offer");
        talker.peer.generateOffer((err, sdpOffer) => {
          if (err) {
            sendError("[handleMakeTalker.WebRtcPeerSendonly.generateOffer] Error: "
                + err);
            stop();
            return;
          }

          sendMessage({
            id: 'PROCESS_SDP_REOFFER',
            webRtcEpId: webRtcEpId,
            sdpOffer: sdpOffer,
          });
        });
      };

      sendMessage({
        id: 'PROCESS_SDP_ANSWER',
        webRtcEpId: webRtcEpId,
        sdpAnswer: sdpAnswer,
      });

      console.log("[talker.WebRtcPeer.processOffer] Done!");
      uiSetState(UI_STARTED);
    });
  });
}



/******************************************************************************/
/* WebSocket signaling                                                        */
/******************************************************************************/

ws.onmessage = function(message)
{
  const jsonMessage = JSON.parse(message.data);
  console.log("[onmessage] Received message: " + message.data);

  switch (jsonMessage.id) {
    case 'MAKE_TALKER':
      handleMakeTalker(jsonMessage);
      break;
    case 'MAKE_LISTENER':
      handleMakeListener(jsonMessage);
      break;
    case 'ADD_ICE_CANDIDATE':
      handleAddIceCandidate(jsonMessage);
      break;
    case 'PROCESS_SDP_REANSWER':
      handleProcessSdpReAnswer(jsonMessage);
      break;
    case 'ERROR':
      handleError(jsonMessage);
      break;
    default:
      console.warn("[onmessage] Invalid message, id: " + jsonMessage.id);
      break;
  }
}

// MAKE_TALKER -----------------------------------------------------------------

function handleMakeTalker(jsonMessage)
{
  makePeer(jsonMessage.sdpOffer, jsonMessage.webRtcEpId);
}

// MAKE_LISTENER ---------------------------------------------------------------

function handleMakeListener(jsonMessage)
{
  const isFirst = (listener1.peer === null);
  const listener = (isFirst ? listener1 : listener2);

  console.log("[handleMakeListener] Make WebRtcPeerRecvonly");

  const webRtcEpId = jsonMessage.webRtcEpId;

  const options = {
    localVideo: null,
    remoteVideo: listener.tag,
    mediaConstraints: { audio: true, video: false },
    onicecandidate: (candidate) => sendMessage({
      id: 'ADD_ICE_CANDIDATE',
      webRtcEpId: webRtcEpId,
      candidate: candidate,
    }),
    onnegotiationneeded: (ev) => console.log("[listener.WebRtcPeer.onnegotiationneeded] NOOP, webRtcEpId: "
        + webRtcEpId),
  };

  listener.peer = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options,
      function(err)
  {
    if (err) {
      sendError("[listener.WebRtcPeer] Error: "
          + explainUserMediaError(err));
      stop();
      return;
    }

    console.log("[listener.WebRtcPeer] Created");

    peers.set(webRtcEpId, listener.peer);
    listener.pc = listener.peer.peerConnection;
    listener.pc.ontrack = (trackEv) => {
      if (trackEv.track.kind === 'audio') {
        console.log("[listener.WebRtcPeer.ontrack] Set incoming stream");
        listener.tag.srcObject = trackEv.streams[0];
        // listener.stream = listener.tag.srcObject;
        // listener.track = listener.stream.getAudioTracks()[0];
        // listener.rtpReceiver = listener.pc.getReceivers().find(
        //     (r) => r.track === listener.track);
      }
    };

    sendMessage({
      id: 'WEBRTCPEER_READY',
      webRtcEpId: webRtcEpId,
    });

    console.log("[listener.WebRtcPeer] Process SDP Offer");
    listener.peer.processOffer(jsonMessage.sdpOffer, (err, sdpAnswer) => {
      if (err) {
        sendError("[listener.WebRtcPeer.processOffer] Error: "
            + err);
        stop();
        return;
      }

      sendMessage({
        id: 'PROCESS_SDP_ANSWER',
        webRtcEpId: webRtcEpId,
        sdpAnswer: sdpAnswer,
      });

      console.log("[listener.WebRtcPeer.processOffer] Done!");
    });
  });
}

// ADD_ICE_CANDIDATE -----------------------------------------------------------

function handleAddIceCandidate(jsonMessage)
{
  const webRtcEpId = jsonMessage.webRtcEpId;
  if (!peers.has(webRtcEpId)) {
    console.warn("[handleAddIceCandidate] Skip, unknown endpoint, id: "
        + webRtcEpId);
    return;
  }

  const peer = peers.get(webRtcEpId);
  peer.addIceCandidate(jsonMessage.candidate, (err) => {
    if (err) {
      console.error("[handleAddIceCandidate] Error: " + err);
      return;
    }
  });
}

// PROCESS_SDP_REANSWER --------------------------------------------------------

function handleProcessSdpReAnswer(jsonMessage)
{
  const webRtcEpId = jsonMessage.webRtcEpId;
  if (!peers.has(webRtcEpId)) {
    console.warn("[handleProcessSdpReAnswer] Skip, unknown endpoint, id: "
        + webRtcEpId);
    return;
  }

  const peer = peers.get(webRtcEpId);
  peer.processAnswer(message.sdpAnswer, (err) => {
    if (err) {
      console.error("[handleProcessSdpReAnswer] " + err);
      return;
    }
  });
}

// STOP ------------------------------------------------------------------------

function stop()
{
  if (uiState == UI_IDLE) {
    console.log("[stop] Skip, already stopped");
    return;
  }

  console.warn("[stop] NOT IMPLEMENTED YET");

  uiSetState(UI_IDLE);

  sendMessage({
    id: 'STOP',
  });
}

// ERROR -----------------------------------------------------------------------

function handleError(jsonMessage)
{
  const errMessage = jsonMessage.message;
  console.error("Kurento error: " + errMessage);

  console.log("Assume that the other side stops after an error...");
  stop();
}



/******************************************************************************/
/* UI actions & state                                                         */
/******************************************************************************/

// Start -----------------------------------------------------------------------

function uiStart()
{
  console.log("[start]");
  uiSetState(UI_STARTING);

  sendMessage({
    id: 'START',
  });
}

// Stop ------------------------------------------------------------------------

function uiStop()
{
  stop();
}

// Mute ------------------------------------------------------------------------

function replaceTrack(isActive)
{
  // https://www.w3.org/TR/webrtc/#dom-rtcrtpsender-replacetrack

  const track = isActive ? null : talker.track;

  console.log("[replaceTrack] Set AUDIO REPLACE " + (isActive ? "ON" : "OFF"));

  talker.rtpSender.replaceTrack(track)
    .then(() => {
      console.log("[replaceTrack] AUDIO REPLACE is "
          + (isActive ? "ON" : "OFF"));
    })
    .catch((err) => {
      if (err.name === 'InvalidModificationError') {
        console.error("[replaceTrack] talker.replaceTrack() error: Renegotiation needed, error: "
            + err);
      }
      else {
        console.error("[replaceTrack] talker.replaceTrack() error: " + err);
      }

      // Update UI (rollback)
      uiMuteChk.checked = !isActive;
    });
}

function removeTrack(isActive)
{
  // https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addtrack
  // https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-removetrack

  console.log("[removeTrack] Set AUDIO REMOVE " + (isActive ? "ON" : "OFF"));

  if (isActive) {
    try {
      talker.pc.removeTrack(talker.rtpSender);
      // removeTrack() triggers onnegotiationneeded
    }
    catch (err) {
      console.error("[removeTrack] talker.pc.removeTrack() error: " + err);

      // Update UI (rollback)
      uiMuteChk.checked = !isActive;

      return;
    }
  }
  else {
    try {
      talker.rtpSender = talker.pc.addTrack(talker.track, talker.stream);
      // addTrack() triggers onnegotiationneeded
    }
    catch (err) {
      console.error("[removeTrack] talker.pc.addTrack() error: " + err);

      // Update UI (rollback)
      uiMuteChk.checked = !isActive;

      return;
    }
  }

  console.log("[removeTrack] AUDIO REMOVE is " + (isActive ? "ON" : "OFF"));
}

function uiMute()
{
  const isActive = uiMuteChk.checked;
  console.log("[mute] active: " + isActive);

  // Choose method for audio mute (uncomment only one!):
  replaceTrack(isActive);
  //removeTrack(isActive)
}

// State handling --------------------------------------------------------------

function uiSetState(newState)
{
  switch (newState) {
    case UI_IDLE:
      uiEnableElement('#uiStartBtn', 'uiStart()');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiMuteChk');
      break;
    case UI_STARTING:
      uiDisableElement('#uiStartBtn');
      uiDisableElement('#uiStopBtn');
      uiDisableElement('#uiMuteChk');
      break;
    case UI_STARTED:
      uiDisableElement('#uiStartBtn');
      uiEnableElement('#uiStopBtn', 'uiStop()');
      uiEnableElement('#uiMuteChk', 'uiMute()');
      break;
    default:
      console.warn("[setState] Skip, invalid state: " + newState);
      return;
  }
  uiState = newState;
}

function uiEnableElement(id, onclickHandler)
{
  $(id).attr('disabled', false);
  if (onclickHandler) {
    $(id).attr('onclick', onclickHandler);
  }
}

function uiDisableElement(id)
{
  $(id).attr('disabled', true);
  $(id).removeAttr('onclick');
}
