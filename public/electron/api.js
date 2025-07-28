const axios = require('axios').default
const logger = require('electron-log');
const Store = require('electron-store')
const axiosRetry = require('axios-retry');
const { chownSync } = require('original-fs');

axiosRetry(axios, {
    retries: 5, // number of retries
    retryDelay: (retryCount) => {
        logger.warn(`api request failed, retrying attempt ${retryCount}`)
        return retryCount * 2000 // time interval between retries
    }
})

const store = new Store();

async function getAccessToken() {
    const settings = store.get("settings");
    if (!settings) return null
    const { client_id, client_secret } = settings

    let accessToken = store.get("access_token")
    if (accessToken && Date.now() < accessToken.expires_on * 1000 * 60 * 10 ) {
        // token is still valid
        return accessToken.access_token
    }

    const headers = {
          "Accept": "application/json",
          "Content-Type": "application/json",
    }
        
    const body = {
          "client_id": client_id,
          "client_secret": client_secret,
          "grant_type": "client_credentials",
          "scope": "public"
    }

    try {
        const response = await axios.post('https://osu.ppy.sh/oauth/token', body, { headers: headers })
        accessToken = response.data
        accessToken.expires_on = Date.now() + (accessToken.expires_in * 1000)
        store.set("access_token", accessToken)
        return accessToken.access_token
    } catch (err) {
        logger.error(err)
        return null
    }
}

async function getScoreRank() {
    const settings = store.get("settings")
    if (!settings) return null
    const { user_id, gamemode } = settings

    try {
        const response = await axios.get(`https://score.respektive.pw/u/${user_id}?mode=${gamemode ?? "osu"}`)
        const scoreRank = response.data
        return scoreRank[0]
    } catch (err) {
        logger.error(err)
        return null
    }
}

async function getOsuUser() {
    const settings = store.get("settings")
    if (!settings) return null;
    const { user_id, gamemode } = settings
    const access_token = await getAccessToken()
    if (!access_token) return null;
    const api = axios.create({
        baseURL: 'https://osu.ppy.sh/api/v2',
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${access_token}`,
            "x-api-version": 20220707
        }
    })

    axiosRetry(api, {
        retries: 5, // number of retries
        retryDelay: (retryCount) => {
            logger.warn(`api request failed, retrying attempt ${retryCount}`)
            return retryCount * 2000 // time interval between retries
        }
    })
    
    try {
        const response = await api.get(`https://osu.ppy.sh/api/v2/users/${user_id}/${gamemode ?? "osu"}`)
        const user = response.data
        user.gamemode = gamemode ?? "osu"
        store.set("username", user.username)
        return user
    } catch (err) {
        logger.error(err)
        if (err.response.status === 401) {
            store.set("access_token", null)
            await getAccessToken()
            const retried_user = await getOsuUser()
            return retried_user
        }
        return null
    }
}

async function getTotalLBCount(rankMax) {
    const params = new URLSearchParams();
    const username = store.get("username")
    
    params.append('u1', username);
    params.append('gamemode', 0);
    params.append('rankMin', 1);
    params.append('rankMax', rankMax);

    try {
        const response = await axios.post('https://osustats.ppy.sh/api/getScores', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const result = response.data;

        if (Array.isArray(result) && result.length >= 2) {
            // console.log(result)
            return result[1]; 
        } else {
            return 0;
        }
    } catch (error) {
        console.error('Error fetching scores:', error);
        return 0;
    }
}


async function getOsuUserActivity() {
    const settings = store.get("settings")
    if (!settings) return null;
    const { user_id } = settings
    const access_token = await getAccessToken()
    if (!access_token) return null;
    const api = axios.create({
        baseURL: 'https://osu.ppy.sh/api/v2',
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${access_token}`,
            "x-api-version": 20220707
        }
    })

    axiosRetry(api, {
        retries: 5, 
        retryDelay: (retryCount) => {
            logger.warn(`api request failed, retrying attempt ${retryCount}`)
            return retryCount * 2000 
        }
    })
    
    try {
        const response = await api.get(`https://osu.ppy.sh/api/v2/users/${user_id}/recent_activity`, {
            params: {
                legacy_only: 0,
                limit: 100
            }
        })
        const activities = response.data
        return activities
    } catch (err) {
        logger.error(err)
        if (err.response.status === 401) {
            store.set("access_token", null)
            await getAccessToken()
            const retried_activities = await getOsuUserActivity()
            return retried_activities
        }
        return null
    }
}   

async function trackLeaderboardSpots() {
    // return list of leaderboard spots (50, 8) #1s are tracked on profile

    let sessionTop50sScores = store.get("top50s_spots") || {}
    let sessionTop50sCount = store.get("top50s_count") || 0

    let sessionTop8sScores = store.get("top8s_spots") || {}
    let sessionTop8sCount = store.get("top8s_count") || 0

    let runCount = store.get("runCount") || 0
    try {
        const activities = await getOsuUserActivity()
        if (!activities) return null;

        activities.forEach(activity => {
            if (activity.type === 'rank') {
                const beatmapTitle = activity.beatmap.title
                const rank = activity.rank
                
                if (!(beatmapTitle in sessionTop50sScores) && rank <= 50) {
                    sessionTop50sScores[beatmapTitle] = rank
                    sessionTop50sCount++

                    if (rank <= 8) {
                        sessionTop8sScores[beatmapTitle] = rank
                        sessionTop8sCount++
                    }

                }
                else if(rank < sessionTop50sScores[beatmapTitle]) {
                    sessionTop50sScores[beatmapTitle] = rank

                    if (!(beatmapTitle in sessionTop8sScores) && rank <= 8) {
                        sessionTop50sScores[beatmapTitle] = rank
                        sessionTop8sCount++
                    }
                }
            }
        })

        // make sure that the leaderboardspots at the start are 0
        // instead of like 80
        if (runCount > 0){
            store.set("top50s_count", sessionTop50sCount)
            store.set("top8s_count", sessionTop8sCount)
            runCount = 0

        } else {
            sessionTop50sCount = 0
            sessionTop8sCount = 0
            store.set("top50s_count", 0)
            store.set("top8s_count", 0)
                
            store.set("Total_top50s_count", await getTotalLBCount(50))
            store.set("Total_top8s_count", await getTotalLBCount(8))
        }

        runCount++
        store.set("runCount", runCount)
        store.set("top50s_spots", sessionTop50sScores)
        store.set("top8s_spots", sessionTop8sScores)

        let TotalTop50sCount = store.get("Total_top50s_count") || 0
        let TotalTop8sCount = store.get("Total_top8s_count") || 0
        console.log(runCount)
        return [sessionTop50sCount + TotalTop50sCount, sessionTop8sCount + TotalTop8sCount]
    } catch (err) {
        logger.error(err)
        return null
    }
}


module.exports = {
    getOsuUser,
    getScoreRank,
    trackLeaderboardSpots
}