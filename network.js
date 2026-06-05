/**
 * NEON UNO MULTIPLAYER - FIREBASE DATABASE LAYER
 * 
 * Firebase Realtime Database を使用して、サーバーレスで安定した通信対戦を実現します。
 * ホストがゲームのステート更新とAI制御を行い、ゲストはアクションをDBにプッシュします。
 */

// ユーザー提供の Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyDGasDLZngBwI6QyK_NsCh2tsmX3xlLqu0",
  authDomain: "uno-game-70a90.firebaseapp.com",
  projectId: "uno-game-70a90",
  storageBucket: "uno-game-70a90.firebasestorage.app",
  messagingSenderId: "18245883917",
  appId: "1:18245883917:web:c59753f063dae5bc105d44"
};

// Firebase初期化
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let roomId = null;
let myPlayerId = null;
let currentLobbyTab = 'create';
let aiCount = 3;
let activeListeners = []; // リスナー解除用の配列

// セッション内での一意なプレイヤーID生成
myPlayerId = 'usr_' + Math.floor(100000 + Math.random() * 900000);

// --- ロビー画面制御 ---
function switchLobbyTab(tab) {
  currentLobbyTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  if (tab === 'create') {
    document.querySelector('.tab-btn:nth-child(1)').classList.add('active');
    document.getElementById('tab-create').classList.add('active');
  } else {
    document.querySelector('.tab-btn:nth-child(2)').classList.add('active');
    document.getElementById('tab-join').classList.add('active');
  }
}

function adjustAICount(delta) {
  const newVal = aiCount + delta;
  if (newVal >= 0 && newVal <= 3) {
    aiCount = newVal;
    document.getElementById('ai-count-val').textContent = aiCount;
    document.getElementById('max-guests').textContent = 3 - aiCount;
  }
}

function copyRoomID() {
  const rId = document.getElementById('display-room-id').textContent;
  if (rId && rId !== '--------') {
    navigator.clipboard.writeText(rId).then(() => {
      showToast("部屋IDをコピーしました！", "success");
    }).catch(() => {
      showToast("コピーに失敗しました。");
    });
  }
}

function getPlayerNameInput() {
  const name = document.getElementById('player-name').value.trim();
  return name || "プレイヤー" + Math.floor(100 + Math.random() * 900);
}

// データベースリスナーのクリア用ヘルパー
function clearActiveListeners() {
  activeListeners.forEach(l => {
    if (l.ref && l.event) {
      l.ref.off(l.event);
    }
  });
  activeListeners = [];
}

function trackListener(ref, event) {
  activeListeners.push({ ref, event });
}

// --- ホスト：部屋の作成 ---
function createRoom() {
  const hostName = getPlayerNameInput();
  roomId = Math.floor(100000 + Math.random() * 900000).toString(); // 6桁の数字ID

  showToast("部屋を作成中...");

  const roomRef = db.ref(`rooms/${roomId}`);
  
  // 部屋IDが重複していないか確認
  roomRef.once('value').then((snapshot) => {
    if (snapshot.exists()) {
      // 重複していた場合は再生成
      createRoom();
      return;
    }

    // データベース上の部屋の初期状態を設定
    const initialData = {
      metadata: {
        hostId: myPlayerId,
        status: 'lobby',
        aiCount: aiCount,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      },
      players: {
        [myPlayerId]: {
          id: myPlayerId,
          name: hostName,
          joinedAt: firebase.database.ServerValue.TIMESTAMP
        }
      },
      state: {},
      actions: {}
    };

    roomRef.set(initialData).then(() => {
      // ホスト切断時の部屋解散処理 (onDisconnect)
      roomRef.onDisconnect().remove();

      // UI切り替え: 待機室表示
      document.getElementById('tab-create').parentElement.classList.add('hidden');
      document.getElementById('waiting-room').classList.remove('hidden');
      document.getElementById('room-status-badge').textContent = "ホスト中";
      document.getElementById('room-status-badge').className = "badge";
      document.getElementById('display-room-id').textContent = roomId;
      document.getElementById('btn-start-game').classList.remove('hidden');

      // ゲームエンジン側の設定
      gameInstance.localPlayerId = myPlayerId;
      gameInstance.isHost = true;

      // 参加プレイヤーのリスニング開始
      listenToPlayersList();
      // ゲストからのアクションのリスニング開始
      listenToGuestActions();

      showToast("部屋が作成されました！", "success");
    }).catch(err => {
      console.error(err);
      showToast("部屋の作成に失敗しました。", "warning");
    });
  });
}

// ホスト：待機プレイヤーリストの監視
function listenToPlayersList() {
  const playersRef = db.ref(`rooms/${roomId}/players`);
  
  const listener = playersRef.on('value', (snapshot) => {
    if (!snapshot.exists()) return;

    const playersData = snapshot.val();
    const lobbyPlayers = [];

    // 人間プレイヤーの読み込み
    Object.keys(playersData).forEach(id => {
      const p = playersData[id];
      lobbyPlayers.push({
        id: p.id,
        name: p.name,
        isHost: p.id === myPlayerId
      });
    });

    // 接続されているゲスト数を把握し、最大ゲスト制限をオーバーしないようにする
    const guests = lobbyPlayers.filter(p => !p.isHost);
    const maxGuests = 3 - aiCount;
    
    // もし制限を超えて入ってきてしまった場合は接続を切る（データベース上から削除）
    if (guests.length > maxGuests) {
      const excessGuests = guests.slice(maxGuests);
      excessGuests.forEach(eg => {
        db.ref(`rooms/${roomId}/players/${eg.id}`).remove();
      });
      showToast("接続上限に達したため、新規の接続を拒否しました。");
      return;
    }

    // AIプレイヤーを追加表示用に入れる
    for (let i = 0; i < aiCount; i++) {
      lobbyPlayers.push({ id: `ai_${i}`, name: `COM ${i + 1}`, isAI: true });
    }

    updateLobbyPlayers(lobbyPlayers);

    // ゲーム中の切断検知 (ゲーム中にプレイヤー数が減った場合)
    const gameScreen = document.getElementById('game-screen');
    if (gameScreen.classList.contains('active') && gameInstance.isHost) {
      handleMidGameDisconnect(playersData);
    }
  });

  trackListener(playersRef, 'value');
}

// ゲーム中に人間プレイヤーが切断された場合の検知 (ホスト用)
function handleMidGameDisconnect(currentOnlinePlayers) {
  let stateChanged = false;

  gameInstance.players.forEach(p => {
    // 登録されているプレイヤーで、AIではなく、現在オンラインリストにいない場合
    if (!p.isAI && p.id !== myPlayerId && !currentOnlinePlayers[p.id]) {
      p.isAI = true;
      p.name += " (AI代替)";
      showToast(`${p.name} が切断されたため、コンピュータが引き継ぎました。`, "warning");
      stateChanged = true;
    }
  });

  if (stateChanged) {
    broadcastGameState();
    checkAITurn();
  }
}

// ホスト：ゲストからのアクションをリッスンする
function listenToGuestActions() {
  const actionsRef = db.ref(`rooms/${roomId}/actions`);
  
  const listener = actionsRef.on('child_added', (snapshot) => {
    if (!snapshot.exists()) return;

    const action = snapshot.val();
    const actionId = snapshot.key;
    const senderId = action.playerId;

    console.log("Received action from guest:", action);

    // アクションのバリデーションと処理
    if (gameInstance.isHost && gameInstance.getCurrentPlayer().id === senderId) {
      let success = false;

      if (action.type === 'PLAY_CARD') {
        success = gameInstance.playCard(senderId, action.cardId, action.chosenColor);
      } else if (action.type === 'DRAW_CARD') {
        success = gameInstance.drawCard(senderId);
      } else if (action.type === 'DECLARE_UNO') {
        success = gameInstance.declareUno(senderId);
      }

      if (success) {
        broadcastGameState();
        checkAITurn();
      }
    }

    // 処理したアクションを削除 (キューの消化)
    db.ref(`rooms/${roomId}/actions/${actionId}`).remove();
  });

  trackListener(actionsRef, 'child_added');
}

// --- ゲスト：部屋に入る ---
function joinRoom() {
  const joinRoomIdInput = document.getElementById('join-room-id').value.trim();
  const guestName = getPlayerNameInput();

  if (!joinRoomIdInput) {
    showToast("部屋IDを入力してください。", "warning");
    return;
  }

  showToast("部屋を探しています...");
  roomId = joinRoomIdInput;

  const roomRef = db.ref(`rooms/${roomId}`);

  roomRef.once('value').then((snapshot) => {
    if (!snapshot.exists()) {
      showToast("指定された部屋IDが見つかりませんでした。入力に誤りがないか確認してください。", "warning");
      return;
    }

    const roomData = snapshot.val();

    // 部屋がすでにゲーム中か確認
    if (roomData.metadata.status !== 'lobby') {
      showToast("その部屋はすでにゲームが開始されています。", "warning");
      return;
    }

    // 接続上限数の検証
    const currentPlayers = roomData.players ? Object.keys(roomData.players).length : 0;
    const aiCountConfig = roomData.metadata.aiCount;
    const maxGuests = 3 - aiCountConfig;

    if (currentPlayers >= (1 + maxGuests)) {
      showToast("部屋が満員のため参加できませんでした。", "warning");
      return;
    }

    // データベースに参加登録
    const playerPathRef = db.ref(`rooms/${roomId}/players/${myPlayerId}`);
    playerPathRef.set({
      id: myPlayerId,
      name: guestName,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
      // ゲストがブラウザを閉じる等で切断された際、リストから自動削除する
      playerPathRef.onDisconnect().remove();

      // UI切り替え
      document.getElementById('tab-join').parentElement.classList.add('hidden');
      document.getElementById('waiting-room').classList.remove('hidden');
      document.getElementById('room-status-badge').textContent = "接続済み";
      document.getElementById('room-status-badge').className = "badge bg-success";
      document.getElementById('display-room-id').textContent = roomId;
      document.getElementById('btn-start-game').classList.add('hidden'); // ゲストは開始ボタン非表示

      // ゲームエンジンの初期化
      gameInstance.localPlayerId = myPlayerId;
      gameInstance.isHost = false;

      // 各種同期リスナーの登録
      listenToLobbyMetaAndPlayers();
      listenToGameStateSync();

      showToast("部屋に参加しました！ホストの開始を待っています。", "success");
    }).catch(err => {
      console.error(err);
      showToast("部屋への参加に失敗しました。", "warning");
    });
  });
}

// ゲスト：待機ロビーのプレイヤーリストとメタデータ（部屋の解散等）の監視
function listenToLobbyMetaAndPlayers() {
  const roomRef = db.ref(`rooms/${roomId}`);

  const listener = roomRef.on('value', (snapshot) => {
    if (!snapshot.exists()) {
      // ホストが切断等で部屋自体が消滅した場合
      showToast("ホストが切断したか、部屋が解散されました。", "warning");
      leaveLobby();
      return;
    }

    const roomData = snapshot.val();

    // ロビー画面時のプレイヤーリスト同期
    const lobbyPlayers = [];
    const playersData = roomData.players || {};

    Object.keys(playersData).forEach(id => {
      const p = playersData[id];
      lobbyPlayers.push({
        id: p.id,
        name: p.name,
        isHost: p.id === roomData.metadata.hostId
      });
    });

    // AIの追加
    const aiCountConfig = roomData.metadata.aiCount;
    for (let i = 0; i < aiCountConfig; i++) {
      lobbyPlayers.push({ id: `ai_${i}`, name: `COM ${i + 1}`, isAI: true });
    }

    updateLobbyPlayers(lobbyPlayers);

    // ゲーム開始指示の検知
    const gameScreen = document.getElementById('game-screen');
    if (roomData.metadata.status === 'playing' && !gameScreen.classList.contains('active')) {
      // ゲーム画面へ遷移
      document.getElementById('lobby-screen').classList.remove('active');
      document.getElementById('game-screen').classList.add('active');
      showToast("ゲームが開始されました！");
    }
  });

  trackListener(roomRef, 'value');
}

// ゲスト：ゲームステートの同期
function listenToGameStateSync() {
  const stateRef = db.ref(`rooms/${roomId}/state`);

  const listener = stateRef.on('value', (snapshot) => {
    if (!snapshot.exists()) return;

    const syncState = snapshot.val();
    
    // ローカルゲームインスタンスに流し込む
    gameInstance.deck = syncState.deck;
    gameInstance.discardPile = syncState.discardPile;
    gameInstance.players = syncState.players;
    gameInstance.turn = syncState.turn;
    gameInstance.direction = syncState.direction;
    gameInstance.currentColor = syncState.currentColor;
    gameInstance.currentValue = syncState.currentValue;

    // UIを更新
    renderGameUI(syncState);
  });

  trackListener(stateRef, 'value');
}

// ゲストからホストへのアクション送信 (DBアクションノードへのpush)
function sendActionToHost(action) {
  if (roomId) {
    // 誰からのアクションか識別できるようにプレイヤーIDを埋め込む
    action.playerId = myPlayerId;
    db.ref(`rooms/${roomId}/actions`).push(action);
  }
}
window.sendActionToHost = sendActionToHost;


// --- ホスト：ゲーム開始 ---
function startGame() {
  if (!gameInstance.isHost) return;

  const roomRef = db.ref(`rooms/${roomId}`);
  
  roomRef.once('value').then((snapshot) => {
    if (!snapshot.exists()) return;

    const roomData = snapshot.val();
    const lobbyPlayers = [];
    const playersData = roomData.players || {};

    // 人間プレイヤーのリスト作成
    Object.keys(playersData).forEach(id => {
      const p = playersData[id];
      lobbyPlayers.push({
        id: p.id,
        name: p.name,
        isHost: p.id === myPlayerId
      });
    });

    // 4人戦にするため、不足分をAIで補う
    const needed = 4 - lobbyPlayers.length;
    for (let i = 0; i < needed; i++) {
      const idx = lobbyPlayers.filter(p => p.isAI).length + 1;
      lobbyPlayers.push({ id: `ai_${idx - 1}`, name: `COM ${idx}`, isAI: true });
    }

    // ゲームエンジンの初期化
    gameInstance.initGame(lobbyPlayers);

    // データベースのメタデータをplayingにし、初回ステートを同期する
    const batchUpdates = {};
    batchUpdates[`rooms/${roomId}/metadata/status`] = 'playing';
    batchUpdates[`rooms/${roomId}/state`] = {
      deck: gameInstance.deck.map(c => ({ id: c.id, color: c.color, value: c.value })),
      discardPile: gameInstance.discardPile,
      players: gameInstance.players,
      turn: gameInstance.turn,
      direction: gameInstance.direction,
      currentColor: gameInstance.currentColor,
      currentValue: gameInstance.currentValue
    };

    db.ref().update(batchUpdates).then(() => {
      // UIの切り替え
      document.getElementById('lobby-screen').classList.remove('active');
      document.getElementById('game-screen').classList.add('active');
      
      // ローカルのUIも更新
      renderGameUI(batchUpdates[`rooms/${roomId}/state`]);

      showToast("ゲームを開始しました！");

      // 最初のターンがAIであれば行動開始
      checkAITurn();
    });
  });
}

// ホストからステートを全員に同期する処理の再定義
function broadcastGameState() {
  if (!gameInstance.isHost || !roomId) return;

  const statePayload = {
    deck: gameInstance.deck.map(c => ({ id: c.id, color: c.color, value: c.value })),
    discardPile: gameInstance.discardPile,
    players: gameInstance.players,
    turn: gameInstance.turn,
    direction: gameInstance.direction,
    currentColor: gameInstance.currentColor,
    currentValue: gameInstance.currentValue
  };

  db.ref(`rooms/${roomId}/state`).set(statePayload).then(() => {
    // ローカルUIも同期
    renderGameUI(statePayload);
  });
}
window.broadcastGameState = broadcastGameState;

// --- 切断・退室処理 ---
function leaveLobby() {
  closeP2PConnection(); // 接続クリア関数

  // UIリセット
  document.getElementById('waiting-room').classList.add('hidden');
  document.getElementById('tab-create').parentElement.classList.remove('hidden');
  document.getElementById('lobby-screen').classList.add('active');
  document.getElementById('game-screen').classList.remove('active');
  
  showToast("ロビーから退出しました。");
}

function closeP2PConnection() {
  // DBの接続・監視リスナーを完全に削除
  clearActiveListeners();

  if (roomId) {
    if (gameInstance.isHost) {
      // ホストの場合は部屋ごと削除して解散
      db.ref(`rooms/${roomId}`).remove();
    } else {
      // ゲストの場合はプレイヤー登録から自身を削除
      db.ref(`rooms/${roomId}/players/${myPlayerId}`).remove();
    }
  }

  roomId = null;
}
window.closeP2PConnection = closeP2PConnection;

// 待機プレイヤーのDOMリスト更新 (game.jsに紐付けるため共通化)
function updateLobbyPlayers(players) {
  const listEl = document.getElementById('player-list');
  const countEl = document.getElementById('connected-count');
  if (!listEl) return;

  listEl.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    let icon = '<i class="fa-solid fa-user"></i>';
    if (p.isHost) {
      li.className = 'host';
      icon = '<i class="fa-solid fa-crown text-warning"></i>';
    } else if (p.isAI) {
      li.className = 'ai';
      icon = '<i class="fa-solid fa-robot"></i>';
    }
    li.innerHTML = `${icon} ${p.name}`;
    listEl.appendChild(li);
  });

  // 人間プレイヤーのカウント
  const humanCount = players.filter(p => !p.isAI).length;
  if (countEl) countEl.textContent = humanCount;
}

// 起動時の初期ロード同期
window.addEventListener('DOMContentLoaded', () => {
  adjustAICount(0);
});
