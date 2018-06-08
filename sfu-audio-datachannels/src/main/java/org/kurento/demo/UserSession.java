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

import java.util.ArrayList;
import java.util.List;

import org.kurento.client.WebRtcEndpoint;
import org.springframework.web.socket.WebSocketSession;

/**
 * Kurento Java Demo - Per-user session state.
 */
public class UserSession
{
  WebSocketSession wsSession;
  private WebRtcEndpoint wEpTalker;
  private final List<WebRtcEndpoint> wEpListeners = new ArrayList<>();

  public UserSession()
  {}

  public WebSocketSession getWsSession()
  { return this.wsSession; }

  public void setWsSession(WebSocketSession wsSession)
  { this.wsSession = wsSession; }

  public WebRtcEndpoint getTalker()
  { return this.wEpTalker; }

  public void setTalker(WebRtcEndpoint wEpTalker)
  { this.wEpTalker = wEpTalker; }

  public List<WebRtcEndpoint> getListeners()
  { return this.wEpListeners; }

  public void addListener(WebRtcEndpoint wEpListener)
  { this.wEpListeners.add(wEpListener); }
}
