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

package org.kurento.demo;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.io.PrintWriter;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

// Kurento client
import org.kurento.client.BaseRtpEndpoint;
import org.kurento.client.EventListener;
import org.kurento.client.IceCandidate;
import org.kurento.client.KurentoClient;
import org.kurento.client.MediaPipeline;
import org.kurento.client.WebRtcEndpoint;
import org.kurento.jsonrpc.JsonUtils;

// Kurento events
import org.kurento.client.ConnectionStateChangedEvent;
import org.kurento.client.DataChannelClosedEvent;
import org.kurento.client.DataChannelOpenedEvent;
import org.kurento.client.ErrorEvent;
import org.kurento.client.IceCandidateFoundEvent;
import org.kurento.client.IceComponentStateChangedEvent;
import org.kurento.client.IceGatheringDoneEvent;
import org.kurento.client.MediaFlowInStateChangeEvent;
import org.kurento.client.MediaFlowOutStateChangeEvent;
import org.kurento.client.MediaStateChangedEvent;
import org.kurento.client.MediaTranscodingStateChangeEvent;
import org.kurento.client.NewCandidatePairSelectedEvent;


/**
 * Kurento Java Demo - WebSocket message handler.
 */
public class Handler extends TextWebSocketHandler
{
  private static final Logger log = LoggerFactory.getLogger(Handler.class);
  private static final Gson gson = new GsonBuilder().create();

  private final ConcurrentHashMap<String, UserSession> users =
      new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, WebRtcEndpoint> webRtcEps =
      new ConcurrentHashMap<>();

  private MediaPipeline pipeline;

  @Autowired
  private KurentoClient kurento;

  /**
	 * Invoked after WebSocket negotiation has succeeded and the WebSocket connection is
	 * opened and ready for use.
	 */
	@Override
  public void afterConnectionEstablished(WebSocketSession session)
      throws Exception
  {
    log.info("[Handler::afterConnectionEstablished] New WebSocket connection, sessionId: {}",
        session.getId());
	}

  /**
	 * Invoked after the WebSocket connection has been closed by either side, or after a
	 * transport error has occurred. Although the session may technically still be open,
	 * depending on the underlying implementation, sending messages at this point is
	 * discouraged and most likely will not succeed.
	 */
	@Override
  public void afterConnectionClosed(final WebSocketSession session,
      CloseStatus status) throws Exception
  {
    if (!status.equalsCode(CloseStatus.NORMAL)) {
      log.warn("[Handler::afterConnectionClosed] status: {}, sessionId: {}",
          status, session.getId());
    }

    stop(session);
  }

  /**
	 * Invoked when a new WebSocket message arrives.
	 */
	@Override
  protected void handleTextMessage(WebSocketSession session,
      TextMessage message) throws Exception
  {
    final String sessionId = session.getId();
    JsonObject jsonMessage = gson.fromJson(message.getPayload(),
        JsonObject.class);

    log.info("[Handler::handleTextMessage] message: {}, sessionId: {}",
        jsonMessage, sessionId);

    try {
      final String messageId = jsonMessage.get("id").getAsString();
      switch (messageId) {
        case "START":
          // Create WebRtcEndpoint and send to browser.
          handleStart(session, jsonMessage);
          break;
        case "WEBRTCPEER_READY":
          // Browser PeerConnection is ready.
          // Start ICE Gathering, send candidates with 'ADD_ICE_CANDIDATE'.
          handleWebRtcPeerReady(session, jsonMessage);
          break;
        case "PROCESS_SDP_ANSWER":
          // Browser PeerConnection processed our SDP Offer.
          // Pass SDP Answer to WebRtcEndpoint.
          handleProcessSdpAnswer(session, jsonMessage);
          break;
        case "ADD_ICE_CANDIDATE":
          // Browser PeerConnection found some candidate.
          // Pass candidate to WebRtcEndpoint.
          handleAddIceCandidate(session, jsonMessage);
          break;
        case "STOP":
          // Not implemented yet.
          handleStop(session, jsonMessage);
          break;
        case "ERROR":
          handleError(session, jsonMessage);
          break;
        default:
          // Ignore the message
          log.warn("[Handler::handleTextMessage] Skip, invalid message, id: {}",
              messageId);
          break;
      }
    } catch (Throwable ex) {
      log.error("[Handler::handleTextMessage] Exception: {}, sessionId: {}",
          ex, sessionId);
      sendError(session, "[Kurento] Exception: " + ex.getMessage());
    }
  }

  /**
	 * Handle an error from the underlying WebSocket message transport.
	 */
	@Override
  public void handleTransportError(WebSocketSession session,
      Throwable exception) throws Exception
  {
    log.error("[Handler::handleTransportError] Exception: {}, sessionId: {}",
        exception, session.getId());

    session.close(CloseStatus.SERVER_ERROR);
  }

  private synchronized void sendMessage(final WebSocketSession session,
      String message)
  {
    log.debug("[Handler::sendMessage] {}", message);

    if (!session.isOpen()) {
      log.warn("[Handler::sendMessage] Skip, WebSocket session isn't open");
      return;
    }

    final String sessionId = session.getId();
    if (!users.containsKey(sessionId)) {
      log.warn("[Handler::sendMessage] Skip, unknown user, id: {}",
          sessionId);
      return;
    }

    try {
      session.sendMessage(new TextMessage(message));
    } catch (IOException ex) {
      log.error("[Handler::sendMessage] Exception: {}", ex.getMessage());
    }
  }

  private void sendError(final WebSocketSession session, String errMsg)
  {
    log.error(errMsg);

    if (users.containsKey(session.getId())) {
      JsonObject message = new JsonObject();
      message.addProperty("id", "ERROR");
      message.addProperty("message", errMsg);
      sendMessage(session, message.toString());
    }
  }

  // START ---------------------------------------------------------------------

  private void initBaseEventListeners(final WebSocketSession session,
      BaseRtpEndpoint baseRtpEp, final String className)
  {
    log.info("[Handler::initBaseEventListeners] name: {}, class: {}, sessionId: {}",
        baseRtpEp.getName(), className, session.getId());

    // Event: Some error happened
    baseRtpEp.addErrorListener(new EventListener<ErrorEvent>() {
      @Override
      public void onEvent(ErrorEvent ev) {
        log.error("[{}::ErrorEvent] Error code {}: '{}', source: {}, timestamp: {}, tags: {}, description: {}",
            className, ev.getErrorCode(), ev.getType(), ev.getSource().getName(),
            ev.getTimestamp(), ev.getTags(), ev.getDescription());

        sendError(session, "[Kurento] " + ev.getDescription());
        stop(session);
      }
    });

    // Event: Media is flowing into this sink
    baseRtpEp.addMediaFlowInStateChangeListener(
        new EventListener<MediaFlowInStateChangeEvent>() {
      @Override
      public void onEvent(MediaFlowInStateChangeEvent ev) {
        log.info("[{}::{}] source: {}, timestamp: {}, tags: {}, state: {}, padName: {}, mediaType: {}",
            className, ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getState(), ev.getPadName(), ev.getMediaType());
      }
    });

    // Event: Media is flowing out of this source
    baseRtpEp.addMediaFlowOutStateChangeListener(
        new EventListener<MediaFlowOutStateChangeEvent>() {
      @Override
      public void onEvent(MediaFlowOutStateChangeEvent ev) {
        log.info("[{}::{}] source: {}, timestamp: {}, tags: {}, state: {}, padName: {}, mediaType: {}",
            className, ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getState(), ev.getPadName(), ev.getMediaType());
      }
    });

    // Event: [TODO write meaning of this event]
    baseRtpEp.addConnectionStateChangedListener(
        new EventListener<ConnectionStateChangedEvent>() {
      @Override
      public void onEvent(ConnectionStateChangedEvent ev) {
        log.info("[{}::{}] source: {}, timestamp: {}, tags: {}, oldState: {}, newState: {}",
            className, ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getOldState(), ev.getNewState());
      }
    });

    // Event: [TODO write meaning of this event]
    baseRtpEp.addMediaStateChangedListener(
        new EventListener<MediaStateChangedEvent>() {
      @Override
      public void onEvent(MediaStateChangedEvent ev) {
        log.info("[{}::{}] source: {}, timestamp: {}, tags: {}, oldState: {}, newState: {}",
            className, ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getOldState(), ev.getNewState());
      }
    });

    // Event: This element will (or will not) perform media transcoding
    baseRtpEp.addMediaTranscodingStateChangeListener(
        new EventListener<MediaTranscodingStateChangeEvent>() {
      @Override
      public void onEvent(MediaTranscodingStateChangeEvent ev) {
        log.info("[{}::{}] source: {}, timestamp: {}, tags: {}, state: {}, binName: {}, mediaType: {}",
            className, ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getState(), ev.getBinName(), ev.getMediaType());
      }
    });
  }

  private void initWebRtcEventListeners(final WebSocketSession session,
      final WebRtcEndpoint webRtcEp)
  {
    log.info("[Handler::initWebRtcEventListeners] name: {}, sessionId: {}",
        webRtcEp.getName(), session.getId());

    // Event: A WebRTC Data Channel has been closed.
    webRtcEp.addDataChannelClosedListener(
        new EventListener<DataChannelCloseEvent>() {
      @Override
      public void onEvent(DataChannelClosedEvent ev) {
        log.info("[WebRtcEndpoint::{}] source: {}, timestamp: {}, tags: {}, channelId: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getChannelId());
      }
    });

    // Event: A WebRTC Data Channel has been opened.
    webRtcEp.addDataChannelOpenedListener(
        new EventListener<DataChannelOpenEvent>() {
      @Override
      public void onEvent(DataChannelOpenEvent ev) {
        log.info("[WebRtcEndpoint::{}] source: {}, timestamp: {}, tags: {}, channelId: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getChannelId());
      }
    });

    // Event: The ICE backend found a local candidate during Trickle ICE
    webRtcEp.addIceCandidateFoundListener(
        new EventListener<IceCandidateFoundEvent>() {
      @Override
      public void onEvent(IceCandidateFoundEvent ev) {
        log.debug("[WebRtcEndpoint::{}] source: {}, timestamp: {}, tags: {}, candidate: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), JsonUtils.toJson(ev.getCandidate()));

        JsonObject message = new JsonObject();
        message.addProperty("id", "ADD_ICE_CANDIDATE");
        message.addProperty("webRtcEpId", webRtcEp.getId());
        message.add("candidate", JsonUtils.toJsonObject(ev.getCandidate()));
        sendMessage(session, message.toString());
      }
    });

    // Event: The ICE backend changed state
    webRtcEp.addIceComponentStateChangedListener(
        new EventListener<IceComponentStateChangedEvent>() {
      @Override
      public void onEvent(IceComponentStateChangedEvent ev) {
        log.debug("[WebRtcEndpoint::{}] source: {}, timestamp: {}, tags: {}, streamId: {}, componentId: {}, state: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getStreamId(), ev.getComponentId(), ev.getState());
      }
    });

    // Event: The ICE backend finished gathering ICE candidates
    webRtcEp.addIceGatheringDoneListener(
        new EventListener<IceGatheringDoneEvent>() {
      @Override
      public void onEvent(IceGatheringDoneEvent ev) {
        log.info("[WebRtcEndpoint::{}] source: {}, timestamp: {}, tags: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags());
      }
    });

    // Event: The ICE backend selected a new pair of ICE candidates for use
    webRtcEp.addNewCandidatePairSelectedListener(
        new EventListener<NewCandidatePairSelectedEvent>() {
      @Override
      public void onEvent(NewCandidatePairSelectedEvent ev) {
        log.info("[WebRtcEndpoint::{}] name: {}, timestamp: {}, tags: {}, streamId: {}, local: {}, remote: {}",
            ev.getType(), ev.getSource().getName(), ev.getTimestamp(),
            ev.getTags(), ev.getCandidatePair().getStreamID(),
            ev.getCandidatePair().getLocalCandidate(),
            ev.getCandidatePair().getRemoteCandidate());
      }
    });
  }

  private void initWebRtcEndpoint(final WebSocketSession session,
      final WebRtcEndpoint webRtcEp, String baseName, String msgId)
  {
    initBaseEventListeners(session, webRtcEp, "WebRtcEndpoint");
    initWebRtcEventListeners(session, webRtcEp);

    final String sessionId = session.getId();
    final String name = baseName + sessionId + "_webrtcendpoint" + webRtcEps.size();
    webRtcEp.setName(name);
    webRtcEps.put(webRtcEp.getId(), webRtcEp);

    // Start an SDP Negotiation
    final String sdpOffer = webRtcEp.generateOffer();

    log.info("[Handler::initWebRtcEndpoint] name: {}, SDP Offer from KMS to browser:\n{}",
        name, sdpOffer);

    JsonObject message = new JsonObject();
    message.addProperty("id", msgId);
    message.addProperty("webRtcEpId", webRtcEp.getId());
    message.addProperty("sdpOffer", sdpOffer);
    sendMessage(session, message.toString());
  }

  private void handleStart(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    final String sessionId = session.getId();
    if (users.containsKey(sessionId)) {
      log.warn("[Handler::handleStart] Skip, user already exists, id: {}",
          sessionId);
      return;
    }

    if (pipeline == null) {
      log.info("[Handler::handleStart] Create Media Pipeline");
      pipeline = kurento.createMediaPipeline();
    }
    else {
      log.info("[Handler::handleStart] Media Pipeline already exists");
    }

    log.info("[Handler::handleStart] User count: {}", users.size());
    log.info("[Handler::handleStart] New user, id: {}", sessionId);

    final UserSession user = new UserSession();
    user.setWsSession(session);
    users.put(sessionId, user);

    // Use 'recvonly' because this Ep is to receive audio from the browser
    final WebRtcEndpoint webRtcEpTalker = new WebRtcEndpoint.Builder(pipeline)
        .recvonly().useDataChannels().build();
    user.setTalker(webRtcEpTalker);
    initWebRtcEndpoint(session, webRtcEpTalker, "talker", "MAKE_TALKER");

    log.info("[Handler::handleStart] New local talker: {}",
        webRtcEpTalker.getName());

    for (final String remoteSessionId : users.keySet()) {
      if (!users.containsKey(remoteSessionId)) {
        // Skip users that might have left while this loop is running
        continue;
      }
      if (remoteSessionId.equals(sessionId)) {
        // Skip itself
        continue;
      }

      UserSession remoteUser = users.get(remoteSessionId);

      // Connect our talker to a new listener on the remote user's side
      // Use 'sendonly' because this Ep is to send audio to the browser
      final WebRtcEndpoint webRtcEpRemoteListener =
          new WebRtcEndpoint.Builder(pipeline).sendonly().useDataChannels()
          .build();
      remoteUser.addListener(webRtcEpRemoteListener);
      webRtcEpTalker.connect(webRtcEpRemoteListener);
      initWebRtcEndpoint(remoteUser.getWsSession(), webRtcEpRemoteListener,
          "listener", "MAKE_LISTENER");

      log.info("[Handler::handleStart] New remote listener: {}",
          webRtcEpRemoteListener.getName());

      // Conect user's talker to a new listener on our side
      // Use 'sendonly' because this Ep is to send audio to the browser
      final WebRtcEndpoint webRtcEpLocalListener =
          new WebRtcEndpoint.Builder(pipeline).sendonly().useDataChannels()
          .build();
      user.addListener(webRtcEpLocalListener);
      remoteUser.getTalker().connect(webRtcEpLocalListener);
      initWebRtcEndpoint(session, webRtcEpLocalListener, "listener",
          "MAKE_LISTENER");

      log.info("[Handler::handleStart] New local listener: {}",
          webRtcEpLocalListener.getName());
    }


    //J
    // ---- Debug
    final String pipelineDot = pipeline.getGstreamerDot();
    try (PrintWriter out = new PrintWriter("pipeline.dot")) {
      out.println(pipelineDot);
    } catch (IOException ex) {
      log.error("[Handler::handleStart] Exception: {}", ex.getMessage());
    }
  }

  // WEBRTCPEER_READY ----------------------------------------------------------

  private void startWebRtcEndpoint(WebRtcEndpoint webRtcEp)
  {
    // Calling gatherCandidates() is when the Endpoint actually starts working.
    // That is emphasized for demonstration purposes in this code, by launching
    // the ICE candidate gathering in its own method.
    webRtcEp.gatherCandidates();
  }

  private void handleWebRtcPeerReady(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    final String webRtcEpId = jsonMessage.get("webRtcEpId").getAsString();
    if (!webRtcEps.containsKey(webRtcEpId)) {
      log.warn("[Handler::handleWebRtcPeerReady] Skip, unknown endpoint, id: {}",
          webRtcEpId);
      return;
    }

    WebRtcEndpoint webRtcEp = webRtcEps.get(webRtcEpId);
    startWebRtcEndpoint(webRtcEp);
  }

  // PROCESS_SDP_ANSWER --------------------------------------------------------

  private void handleProcessSdpAnswer(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    final String webRtcEpId = jsonMessage.get("webRtcEpId").getAsString();
    if (!webRtcEps.containsKey(webRtcEpId)) {
      log.warn("[Handler::handleProcessSdpAnswer] Skip, unknown endpoint, id: {}",
          webRtcEpId);
      return;
    }

    final String sdpAnswer = jsonMessage.get("sdpAnswer").getAsString();

    WebRtcEndpoint webRtcEp = webRtcEps.get(webRtcEpId);
    log.info("[Handler::handleProcessSdpAnswer] name: {}, SDP Answer from browser to KMS:\n{}",
        webRtcEp.getName(), sdpAnswer);
    webRtcEp.processAnswer(sdpAnswer);
  }

  // ADD_ICE_CANDIDATE ---------------------------------------------------------

  private void handleAddIceCandidate(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    final String webRtcEpId = jsonMessage.get("webRtcEpId").getAsString();
    if (!webRtcEps.containsKey(webRtcEpId)) {
      log.warn("[Handler::handleAddIceCandidate] Skip, unknown endpoint, id: {}",
          webRtcEpId);
      return;
    }

    final JsonObject jsonCandidate =
        jsonMessage.get("candidate").getAsJsonObject();
    final IceCandidate candidate =
        new IceCandidate(jsonCandidate.get("candidate").getAsString(),
        jsonCandidate.get("sdpMid").getAsString(),
        jsonCandidate.get("sdpMLineIndex").getAsInt());

    WebRtcEndpoint webRtcEp = webRtcEps.get(webRtcEpId);
    webRtcEp.addIceCandidate(candidate);
  }

  // STOP ----------------------------------------------------------------------

  private void stop(final WebSocketSession session)
  {
    log.warn("[Handler::stop] NOT IMPLEMENTED YET");
  }

  private void handleStop(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    stop(session);
  }

  // ERROR ---------------------------------------------------------------------

  private void handleError(final WebSocketSession session,
      JsonObject jsonMessage)
  {
    final String errMsg = jsonMessage.get("message").getAsString();
    log.error("Browser error: " + errMsg);

    log.info("Assume that the other side stops after an error...");
    stop(session);
  }
}
