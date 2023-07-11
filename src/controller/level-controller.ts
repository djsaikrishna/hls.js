/*
 * Level Controller
 */

import {
  ManifestLoadedData,
  ManifestParsedData,
  LevelLoadedData,
  TrackSwitchedData,
  ErrorData,
  LevelSwitchingData,
  LevelsUpdatedData,
  ManifestLoadingData,
  FragBufferedData,
} from '../types/events';
import { Level, addGroupId, isVideoRange } from '../types/level';
import { Events } from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';
import {
  areCodecsMediaSourceSupported,
  codecsSetSelectionPreferenceValue,
  getCodecCompatibleName,
} from '../utils/codecs';
import BasePlaylistController from './base-playlist-controller';
import { PlaylistContextType, PlaylistLevelType } from '../types/loader';
import { hlsDefaultConfig } from '../config';
import type Hls from '../hls';
import type { HlsUrlParameters, LevelParsed } from '../types/level';
import type { MediaPlaylist } from '../types/media-playlist';
import ContentSteeringController from './content-steering-controller';

let chromeOrFirefox: boolean;

export default class LevelController extends BasePlaylistController {
  private _levels: Level[] = [];
  private _firstLevel: number = -1;
  private _startLevel?: number;
  private currentLevel: Level | null = null;
  private currentLevelIndex: number = -1;
  private manualLevelIndex: number = -1;
  private steering: ContentSteeringController | null;

  public onParsedComplete!: Function;

  constructor(
    hls: Hls,
    contentSteeringController: ContentSteeringController | null
  ) {
    super(hls, '[level-controller]');
    this.steering = contentSteeringController;
    this._registerListeners();
  }

  private _registerListeners() {
    const { hls } = this;
    hls.on(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.on(Events.MANIFEST_LOADED, this.onManifestLoaded, this);
    hls.on(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.on(Events.LEVELS_UPDATED, this.onLevelsUpdated, this);
    hls.on(Events.AUDIO_TRACK_SWITCHED, this.onAudioTrackSwitched, this);
    hls.on(Events.FRAG_BUFFERED, this.onFragBuffered, this);
    hls.on(Events.ERROR, this.onError, this);
  }

  private _unregisterListeners() {
    const { hls } = this;
    hls.off(Events.MANIFEST_LOADING, this.onManifestLoading, this);
    hls.off(Events.MANIFEST_LOADED, this.onManifestLoaded, this);
    hls.off(Events.LEVEL_LOADED, this.onLevelLoaded, this);
    hls.off(Events.LEVELS_UPDATED, this.onLevelsUpdated, this);
    hls.off(Events.AUDIO_TRACK_SWITCHED, this.onAudioTrackSwitched, this);
    hls.off(Events.FRAG_BUFFERED, this.onFragBuffered, this);
    hls.off(Events.ERROR, this.onError, this);
  }

  public destroy() {
    this._unregisterListeners();
    this.steering = null;
    this.resetLevels();
    super.destroy();
  }

  public stopLoad(): void {
    const levels = this._levels;

    // clean up live level details to force reload them, and reset load errors
    levels.forEach((level) => {
      level.loadError = 0;
      level.fragmentError = 0;
    });

    super.stopLoad();
  }

  private resetLevels() {
    this._startLevel = undefined;
    this.manualLevelIndex = -1;
    this.currentLevelIndex = -1;
    this.currentLevel = null;
    this._levels = [];
  }

  private onManifestLoading(
    event: Events.MANIFEST_LOADING,
    data: ManifestLoadingData
  ) {
    this.resetLevels();
  }

  protected onManifestLoaded(
    event: Events.MANIFEST_LOADED,
    data: ManifestLoadedData
  ) {
    const levels: Level[] = [];
    const levelSet: { [key: string]: Level } = {};
    let levelFromSet: Level;

    // regroup redundant levels together
    data.levels.forEach((levelParsed: LevelParsed) => {
      const attributes = levelParsed.attrs;

      // erase audio codec info if browser does not support mp4a.40.34.
      // demuxer will autodetect codec and fallback to mpeg/audio
      if (levelParsed.audioCodec?.indexOf('mp4a.40.34') !== -1) {
        chromeOrFirefox ||= /chrome|firefox/i.test(navigator.userAgent);
        if (chromeOrFirefox) {
          levelParsed.audioCodec = undefined;
        }
      }

      if (levelParsed.audioCodec) {
        levelParsed.audioCodec = getCodecCompatibleName(levelParsed.audioCodec);
      }

      const {
        AUDIO,
        CODECS,
        'FRAME-RATE': FRAMERATE,
        'PATHWAY-ID': PATHWAY,
        RESOLUTION,
        SUBTITLES,
      } = attributes;
      const contentSteeringPrefix = __USE_CONTENT_STEERING__
        ? `${PATHWAY || '.'}-`
        : '';
      const levelKey = `${contentSteeringPrefix}${levelParsed.bitrate}-${RESOLUTION}-${FRAMERATE}-${CODECS}`;
      levelFromSet = levelSet[levelKey];

      if (!levelFromSet) {
        levelFromSet = new Level(levelParsed);
        levelSet[levelKey] = levelFromSet;
        levels.push(levelFromSet);
      } else {
        levelFromSet.addFallback(levelParsed);
      }

      addGroupId(levelFromSet, 'audio', AUDIO);
      addGroupId(levelFromSet, 'text', SUBTITLES);
    });

    this.filterAndSortMediaOptions(levels, data);
  }

  private filterAndSortMediaOptions(
    unfilteredLevels: Level[],
    data: ManifestLoadedData
  ) {
    let audioTracks: MediaPlaylist[] = [];
    let subtitleTracks: MediaPlaylist[] = [];

    let resolutionFound = false;
    let videoCodecFound = false;
    let audioCodecFound = false;

    // only keep levels with supported audio/video codecs
    let levels = unfilteredLevels.filter(
      ({ audioCodec, videoCodec, width, height, unknownCodecs }) => {
        resolutionFound ||= !!(width && height);
        videoCodecFound ||= !!videoCodec;
        audioCodecFound ||= !!audioCodec;
        return (
          !unknownCodecs?.length &&
          (!audioCodec || areCodecsMediaSourceSupported(audioCodec, 'audio')) &&
          (!videoCodec || areCodecsMediaSourceSupported(videoCodec, 'video'))
        );
      }
    );

    // remove audio-only and invalid video-range levels if we also have levels with video codecs or RESOLUTION signalled
    if ((resolutionFound || videoCodecFound) && audioCodecFound) {
      levels = levels.filter(
        ({ videoCodec, videoRange, width, height }) =>
          !!videoCodec || !!(width && height) || !isVideoRange(videoRange)
      );
    }

    if (levels.length === 0) {
      // Dispatch error after MANIFEST_LOADED is done propagating
      Promise.resolve().then(() => {
        if (this.hls) {
          if (unfilteredLevels.length) {
            this.warn(
              `One or more CODECS in variant not supported: ${JSON.stringify(
                unfilteredLevels[0].attrs
              )}`
            );
          }
          const error = new Error(
            'no level with compatible codecs found in manifest'
          );
          this.hls.trigger(Events.ERROR, {
            type: ErrorTypes.MEDIA_ERROR,
            details: ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
            fatal: true,
            url: data.url,
            error,
            reason: error.message,
          });
        }
      });
      return;
    }

    if (data.audioTracks) {
      audioTracks = data.audioTracks.filter(
        (track) =>
          !track.audioCodec ||
          areCodecsMediaSourceSupported(track.audioCodec, 'audio')
      );
      // Assign ids after filtering as array indices by group-id
      assignTrackIdsByGroup(audioTracks);
    }

    if (data.subtitles) {
      subtitleTracks = data.subtitles;
      assignTrackIdsByGroup(subtitleTracks);
    }
    // start bitrate is the first bitrate of the manifest
    const unsortedLevels = levels.slice(0);
    // sort levels from lowest to highest
    levels.sort((a, b) => {
      if (a.attrs['HDCP-LEVEL'] !== b.attrs['HDCP-LEVEL']) {
        return (a.attrs['HDCP-LEVEL'] || '') > (b.attrs['HDCP-LEVEL'] || '')
          ? 1
          : -1;
      }
      // sort on height before bitrate for cap-level-controller
      if (resolutionFound && a.height !== b.height) {
        return a.height - b.height;
      }
      if (a.frameRate !== b.frameRate) {
        return a.frameRate - b.frameRate;
      }
      if (a.codecSet !== b.codecSet) {
        const valueA = codecsSetSelectionPreferenceValue(a.codecSet);
        const valueB = codecsSetSelectionPreferenceValue(b.codecSet);
        if (valueA !== valueB) {
          return valueB - valueA;
        }
      }
      if (a.bitrate !== b.bitrate) {
        return a.bitrate - b.bitrate;
      }
      if (a.attrs.SCORE !== b.attrs.SCORE) {
        return (
          a.attrs.decimalFloatingPoint('SCORE') -
          b.attrs.decimalFloatingPoint('SCORE')
        );
      }
      return 0;
    });

    let firstLevelInPlaylist = unsortedLevels[0];
    if (this.steering) {
      levels = this.steering.filterParsedLevels(levels);
      if (levels.length !== unsortedLevels.length) {
        for (let i = 0; i < unsortedLevels.length; i++) {
          if (unsortedLevels[i].pathwayId === levels[0].pathwayId) {
            firstLevelInPlaylist = unsortedLevels[i];
            break;
          }
        }
      }
    }

    this._levels = levels;

    // find index of first level in sorted levels
    for (let i = 0; i < levels.length; i++) {
      if (levels[i] === firstLevelInPlaylist) {
        this._firstLevel = i;
        const firstLevelBitrate = firstLevelInPlaylist.bitrate;
        const bandwidthEstimate = this.hls.bandwidthEstimate;
        this.log(
          `manifest loaded, ${levels.length} level(s) found, first bitrate: ${firstLevelBitrate}`
        );
        // Update default bwe to first variant bitrate as long it has not been configured or set
        if (this.hls.userConfig?.abrEwmaDefaultEstimate === undefined) {
          const startingBwEstimate = Math.min(firstLevelBitrate, 5e6); // 5mbps
          if (
            startingBwEstimate > bandwidthEstimate &&
            bandwidthEstimate === hlsDefaultConfig.abrEwmaDefaultEstimate
          ) {
            this.hls.bandwidthEstimate = startingBwEstimate;
          }
        }
        break;
      }
    }

    // Audio is only alternate if manifest include a URI along with the audio group tag,
    // and this is not an audio-only stream where levels contain audio-only
    const audioOnly = audioCodecFound && !videoCodecFound;
    const edata: ManifestParsedData = {
      levels,
      audioTracks,
      subtitleTracks,
      sessionData: data.sessionData,
      sessionKeys: data.sessionKeys,
      firstLevel: this._firstLevel,
      stats: data.stats,
      audio: audioCodecFound,
      video: videoCodecFound,
      altAudio: !audioOnly && audioTracks.some((t) => !!t.url),
    };
    this.hls.trigger(Events.MANIFEST_PARSED, edata);

    // Initiate loading after all controllers have received MANIFEST_PARSED
    if (this.hls.config.autoStartLoad || this.hls.forceStartLoad) {
      this.hls.startLoad(this.hls.config.startPosition);
    }
  }

  get levels(): Level[] | null {
    if (this._levels.length === 0) {
      return null;
    }
    return this._levels;
  }

  get level(): number {
    return this.currentLevelIndex;
  }

  set level(newLevel: number) {
    const levels = this._levels;
    if (levels.length === 0) {
      return;
    }
    // check if level idx is valid
    if (newLevel < 0 || newLevel >= levels.length) {
      // invalid level id given, trigger error
      const error = new Error('invalid level idx');
      const fatal = newLevel < 0;
      this.hls.trigger(Events.ERROR, {
        type: ErrorTypes.OTHER_ERROR,
        details: ErrorDetails.LEVEL_SWITCH_ERROR,
        level: newLevel,
        fatal,
        error,
        reason: error.message,
      });
      if (fatal) {
        return;
      }
      newLevel = Math.min(newLevel, levels.length - 1);
    }

    const lastLevelIndex = this.currentLevelIndex;
    const lastLevel = this.currentLevel;
    const lastPathwayId = lastLevel ? lastLevel.attrs['PATHWAY-ID'] : undefined;
    const level = levels[newLevel];
    const pathwayId = level.attrs['PATHWAY-ID'];
    this.currentLevelIndex = newLevel;
    this.currentLevel = level;

    if (
      lastLevelIndex === newLevel &&
      level.details &&
      lastLevel &&
      lastPathwayId === pathwayId
    ) {
      return;
    }

    this.log(
      `Switching to level ${newLevel} (${
        level.height ? level.height + 'p ' : ''
      }${level.videoRange ? level.videoRange + ' ' : ''}${
        level.codecSet ? level.codecSet + ' ' : ''
      }@${level.bitrate})${
        pathwayId ? ' with Pathway ' + pathwayId : ''
      } from level ${lastLevelIndex}${
        lastPathwayId ? ' with Pathway ' + lastPathwayId : ''
      }`
    );

    const levelSwitchingData: LevelSwitchingData = Object.assign({}, level, {
      level: newLevel,
      maxBitrate: level.maxBitrate,
      attrs: level.attrs,
      uri: level.uri,
      urlId: level.urlId,
    });
    // @ts-ignore
    delete levelSwitchingData._attrs;
    // @ts-ignore
    delete levelSwitchingData._urlId;
    // @ts-ignore
    delete levelSwitchingData._avgBitrate;
    this.hls.trigger(Events.LEVEL_SWITCHING, levelSwitchingData);
    // check if we need to load playlist for this level
    const levelDetails = level.details;
    if (!levelDetails || levelDetails.live) {
      // level not retrieved yet, or live playlist we need to (re)load it
      const hlsUrlParameters = this.switchParams(level.uri, lastLevel?.details);
      this.loadPlaylist(hlsUrlParameters);
    }
  }

  get manualLevel(): number {
    return this.manualLevelIndex;
  }

  set manualLevel(newLevel) {
    this.manualLevelIndex = newLevel;
    if (this._startLevel === undefined) {
      this._startLevel = newLevel;
    }

    if (newLevel !== -1) {
      this.level = newLevel;
    }
  }

  get firstLevel(): number {
    return this._firstLevel;
  }

  set firstLevel(newLevel) {
    this._firstLevel = newLevel;
  }

  get startLevel() {
    // hls.startLevel takes precedence over config.startLevel
    // if none of these values are defined, fallback on firstAutoLevel (abr selection using bandwidth of first variant in playlist)
    if (this._startLevel === undefined) {
      const configStartLevel = this.hls.config.startLevel;
      if (configStartLevel !== undefined) {
        return configStartLevel;
      } else {
        const firstAutoLevel = this.hls.firstAutoLevel;
        return firstAutoLevel;
      }
    } else {
      return this._startLevel;
    }
  }

  set startLevel(newLevel) {
    this._startLevel = newLevel;
  }

  protected onError(event: Events.ERROR, data: ErrorData) {
    if (data.fatal || !data.context) {
      return;
    }

    if (
      data.context.type === PlaylistContextType.LEVEL &&
      data.context.level === this.level
    ) {
      this.checkRetry(data);
    }
  }

  // reset errors on the successful load of a fragment
  protected onFragBuffered(
    event: Events.FRAG_BUFFERED,
    { frag }: FragBufferedData
  ) {
    if (frag !== undefined && frag.type === PlaylistLevelType.MAIN) {
      const el = frag.elementaryStreams;
      if (!Object.keys(el).some((type) => !!el[type])) {
        return;
      }
      const level = this._levels[frag.level];
      if (level?.loadError) {
        this.log(
          `Resetting level error count of ${level.loadError} on frag buffered`
        );
        level.loadError = 0;
      }
    }
  }

  protected onLevelLoaded(event: Events.LEVEL_LOADED, data: LevelLoadedData) {
    const { level, details } = data;
    const curLevel = this._levels[level];

    if (!curLevel) {
      this.warn(`Invalid level index ${level}`);
      if (data.deliveryDirectives?.skip) {
        details.deltaUpdateFailed = true;
      }
      return;
    }

    // only process level loaded events matching with expected level
    if (level === this.currentLevelIndex) {
      // reset level load error counter on successful level loaded only if there is no issues with fragments
      if (curLevel.fragmentError === 0) {
        curLevel.loadError = 0;
      }
      this.playlistLoaded(level, data, curLevel.details);
    } else if (data.deliveryDirectives?.skip) {
      // received a delta playlist update that cannot be merged
      details.deltaUpdateFailed = true;
    }
  }

  protected onAudioTrackSwitched(
    event: Events.AUDIO_TRACK_SWITCHED,
    data: TrackSwitchedData
  ) {
    const currentLevel = this.currentLevel;
    if (!currentLevel) {
      return;
    }

    const audioGroupId = this.hls.audioTracks[data.id].groupId;
    if (
      currentLevel.audioGroupIds &&
      currentLevel.audioGroupId !== audioGroupId
    ) {
      let urlId = -1;
      for (let i = 0; i < currentLevel.audioGroupIds.length; i++) {
        if (currentLevel.audioGroupIds[i] === audioGroupId) {
          urlId = i;
          break;
        }
      }

      if (urlId !== -1 && urlId !== currentLevel.urlId) {
        currentLevel.urlId = urlId;
        if (this.canLoad) {
          this.startLoad();
        }
      }
    }
  }

  protected loadPlaylist(hlsUrlParameters?: HlsUrlParameters) {
    super.loadPlaylist();
    const currentLevelIndex = this.currentLevelIndex;
    const currentLevel = this.currentLevel;

    if (currentLevel && this.shouldLoadPlaylist(currentLevel)) {
      const id = currentLevel.urlId;
      let url = currentLevel.uri;
      if (hlsUrlParameters) {
        try {
          url = hlsUrlParameters.addDirectives(url);
        } catch (error) {
          this.warn(
            `Could not construct new URL with HLS Delivery Directives: ${error}`
          );
        }
      }

      const pathwayId = currentLevel.attrs['PATHWAY-ID'];
      this.log(
        `Loading level index ${currentLevelIndex}${
          hlsUrlParameters?.msn !== undefined
            ? ' at sn ' +
              hlsUrlParameters.msn +
              ' part ' +
              hlsUrlParameters.part
            : ''
        } with${pathwayId ? ' Pathway ' + pathwayId : ''} URI ${id + 1}/${
          currentLevel.url.length
        } ${url}`
      );

      // console.log('Current audio track group ID:', this.hls.audioTracks[this.hls.audioTrack].groupId);
      // console.log('New video quality level audio group id:', levelObject.attrs.AUDIO, level);
      this.clearTimer();
      this.hls.trigger(Events.LEVEL_LOADING, {
        url,
        level: currentLevelIndex,
        id,
        deliveryDirectives: hlsUrlParameters || null,
      });
    }
  }

  get nextLoadLevel() {
    if (this.manualLevelIndex !== -1) {
      return this.manualLevelIndex;
    } else {
      return this.hls.nextAutoLevel;
    }
  }

  set nextLoadLevel(nextLevel) {
    this.level = nextLevel;
    if (this.manualLevelIndex === -1) {
      this.hls.nextAutoLevel = nextLevel;
    }
  }

  removeLevel(levelIndex, urlId) {
    const filterLevelAndGroupByIdIndex = (url, id) => id !== urlId;
    const levels = this._levels.filter((level, index) => {
      if (index !== levelIndex) {
        return true;
      }

      if (level.url.length > 1 && urlId !== undefined) {
        level.url = level.url.filter(filterLevelAndGroupByIdIndex);
        if (level.audioGroupIds) {
          level.audioGroupIds = level.audioGroupIds.filter(
            filterLevelAndGroupByIdIndex
          );
        }
        if (level.textGroupIds) {
          level.textGroupIds = level.textGroupIds.filter(
            filterLevelAndGroupByIdIndex
          );
        }
        level.urlId = 0;
        return true;
      }
      if (this.steering) {
        this.steering.removeLevel(level);
      }
      return false;
    });

    this.hls.trigger(Events.LEVELS_UPDATED, { levels });
  }

  private onLevelsUpdated(
    event: Events.LEVELS_UPDATED,
    { levels }: LevelsUpdatedData
  ) {
    levels.forEach((level, index) => {
      const { details } = level;
      if (details?.fragments) {
        details.fragments.forEach((fragment) => {
          fragment.level = index;
        });
      }
    });
    this._levels = levels;
  }
}

function assignTrackIdsByGroup(tracks: MediaPlaylist[]): void {
  const groups = {};
  tracks.forEach((track) => {
    const groupId = track.groupId || '';
    track.id = groups[groupId] = groups[groupId] || 0;
    groups[groupId]++;
  });
}
