import Helpers from "./common.js";
import logger from "../../logger.js";
import utils from "../../utils.js";
import { DirectoryPicker } from "../../lib/DirectoryPicker.js";
import { checkMonsterCompendium } from "../importMonster.js";
import { parseCritters } from "../monsters.js";
import { parseSpells } from "../spells.js";
import { parseItems } from "../items.js";
import { generateAdventureConfig } from "../adventure.js";
import { getPatreonTiers, getCompendiumType } from "../utils.js";

const COMPENDIUM_MAP = {
  "spells": "spells",
  "magicitems": "items",
  "weapons": "items",
  "armor": "items",
  "adventuring-gear": "items",
  "monsters": "monsters",
};

const DDB_MAP = {
  "spells": "spells",
  "magicitems": "magic-items",
  "weapons": "equipment",
  "armor": "equipment",
  "adventuring-gear": "equipment",
  "monsters": "monsters",
};

export default class AdventureMunch extends FormApplication {
  /** @override */
  constructor(object = {}, options = {}) {
    super(object, options);
    this._itemsToRevisit = [];
    const importPathData = game.settings.get("ddb-importer", "adventure-import-path");
    this._importPathData = DirectoryPicker.parse(importPathData);
  }

  /** @override */
  static get defaultOptions() {
    this.pattern = /(@[a-z]*)(\[)([a-z0-9]*|[a-z0-9.]*)(\])(\{)(.*?)(\})/gmi;
    this.altpattern = /((data-entity)=\\?["']?([a-zA-Z]*)\\?["']?|(data-pack)=\\?["']?([[\S.]*)\\?["']?) data-id=\\?["']?([a-zA-Z0-9]*)\\?["']?.*?>(.*?)<\/a>/gmi;

    return mergeObject(super.defaultOptions, {
      id: "ddb-adventure-import",
      classes: ["ddb-adventure-import"],
      title: "Adventure Munch",
      template: "modules/ddb-importer/handlebars/adventure/import.hbs",
      width: 350,
    });
  }

  /** @override */
  // eslint-disable-next-line class-methods-use-this
  async getData() {
    let data;
    let files = [];

    try {
      // const parsedDirectory = DirectoryPicker.parse(this._importPathData);
      const verifiedDirectory = await DirectoryPicker.verifyPath(this._importPathData);
      if (verifiedDirectory) {
        const options = { bucket: this._importPathData.bucket, extensions: [".fvttadv", ".FVTTADV", ".zip"], wildcard: false };
        data = await Helpers.BrowseFiles(this._importPathData.activeSource, this._importPathData.current, options);
        files = data.files.map((file) => {
          const filename = decodeURIComponent(file).replace(/^.*[\\/]/, '');

          return { path: decodeURIComponent(file), name: filename };
        });
      }
    } catch (err) {
      logger.error(err);
      logger.warn(`Unable to verify import path, this may be due to permissions on the server. You may be able to ignore this message.`);
    }

    return {
      data,
      files,
      cssClass: "ddb-importer-window"
    };

  }

  static async _createFolders(adventure, folders) {
    if (folders) {
      const maintainFolders = adventure?.options?.folders;
      let itemFolder = null;
      if (!maintainFolders) {
        const importTypes = ["Scene", "Actor", "Item", "JournalEntry", "RollTable"];
        await Helpers.asyncForEach(importTypes, async (importType) => {
          itemFolder = game.folders.find((folder) => {
            return folder.data.name === adventure.name && folder.data.type === importType;
          });

          if (!itemFolder) {
            logger.debug(`Creating folder ${adventure.name} - ${importType}`);

            // eslint-disable-next-line require-atomic-updates
            itemFolder = await Folder.create({
              color: adventure.folderColour ? adventure.folderColour : "#FF0000",
              name: adventure.name,
              parent: null,
              type: importType
            }, { keepId: true });
          }

          CONFIG.DDBI.ADVENTURE.TEMPORARY.folders[importType] = itemFolder.data._id;
        });
      } else {
        CONFIG.DDBI.ADVENTURE.TEMPORARY.folders["null"] = null;
        CONFIG.DDBI.ADVENTURE.TEMPORARY.lookups = null;
      }

      // the folder list could be out of order, we need to create all folders with parent null first
      const firstLevelFolders = folders.filter((folder) => folder.parent === null);
      await Helpers.importFolder(itemFolder, firstLevelFolders, adventure, folders);
    }
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);

    html.find(".dialog-button").on("click", this._dialogButton.bind(this));
  }

  // eslint-disable-next-line complexity
  async _dialogButton(event) {
    event.preventDefault();
    event.stopPropagation();
    const a = event.currentTarget;
    const action = a.dataset.button;

    if (action === "import") {
      let importFilename;
      try {
        $(".import-progress").toggleClass("import-hidden");
        $(".ddb-overlay").toggleClass("import-invalid");

        const form = $("form.ddb-importer-window")[0];

        let zip;
        if (form.data.files.length) {
          importFilename = form.data.files[0].name;
          zip = await Helpers.readBlobFromFile(form.data.files[0]).then(JSZip.loadAsync);
        } else {
          const selectedFile = $("#import-file").val();
          importFilename = selectedFile;
          zip = await fetch(`/${selectedFile}`)
            .then((response) => {
                if (response.status === 200 || response.status === 0) {
                    return Promise.resolve(response.blob());
                } else {
                    return Promise.reject(new Error(response.statusText));
                }
            })
            .then(JSZip.loadAsync);
        }

        const adventure = JSON.parse(await zip.file("adventure.json").async("text"));
        let folders;
        try {
          folders = JSON.parse(await zip.file("folders.json").async("text"));
        } catch (err) {
          logger.warn(`Folder structure file not found.`);
        }

        if (adventure.system !== game.data.system.data.name) {
          ui.notifications.error(`Invalid sysytem for Adventure ${adventure.name}.  Expects ${adventure.system}`);
          throw new Error(`Invalid sysytem for Adventure ${adventure.name}.  Expects ${adventure.system}`);
        }

        CONFIG.DDBI.ADVENTURE.TEMPORARY = {
          folders: {},
          import: {},
          actors: {},
          sceneTokens: {},
        };

        await AdventureMunch._createFolders(adventure, folders);

        if (adventure.required?.monsters && adventure.required.monsters.length > 0) {
          logger.debug(`${adventure.name} - monsters required`, adventure.required.monsters);
          AdventureMunch._progressNote(`Checking for missing monsters from DDB`);
          await AdventureMunch._checkForMissingDocuments("monster", adventure.required.monsters);
        }
        if (adventure.required?.spells && adventure.required.spells.length > 0) {
          logger.debug(`${adventure.name} - spells required`, adventure.required.spells);
          AdventureMunch._progressNote(`Checking for missing spells from DDB`);
          await AdventureMunch._checkForMissingDocuments("spell", adventure.required.spells);
        }
        if (adventure.required?.items && adventure.required.items.length > 0) {
          logger.debug(`${adventure.name} - items required`, adventure.required.items);
          AdventureMunch._progressNote(`Checking for missing items from DDB`);
          await AdventureMunch._checkForMissingDocuments("item", adventure.required.items);
        }

        // now we have imported all missing data, generate the lookup data
        CONFIG.DDBI.ADVENTURE.TEMPORARY.lookups = await generateAdventureConfig();
        logger.debug("Lookups loaded", CONFIG.DDBI.ADVENTURE.TEMPORARY.lookups.lookups);

        if (AdventureMunch._folderExists("scene", zip)) {
          logger.debug(`${adventure.name} - Loading scenes`);
          await this._checkForDataUpdates("scene", zip, adventure);
        }
        if (AdventureMunch._folderExists("actor", zip)) {
          logger.debug(`${adventure.name} - Loading actors`);
          await this._importFile("actor", zip, adventure);
        }
        if (AdventureMunch._folderExists("item", zip)) {
          logger.debug(`${adventure.name} - Loading item`);
          await this._importFile("item", zip, adventure);
        }
        if (AdventureMunch._folderExists("journal", zip)) {
          logger.debug(`${adventure.name} - Loading journal`);
          await this._importFile("journal", zip, adventure);
        }
        if (AdventureMunch._folderExists("table", zip)) {
          logger.debug(`${adventure.name} - Loading table`);
          await this._importFile("table", zip, adventure);
        }
        if (AdventureMunch._folderExists("playlist", zip)) {
          logger.debug(`${adventure.name} - Loading playlist`);
          await this._importFile("playlist", zip, adventure);
        }
        if (AdventureMunch._folderExists("compendium", zip)) {
          logger.debug(`${adventure.name} - Loading compendium`);
          await this._importCompendium("compendium", zip, adventure);
        }
        if (AdventureMunch._folderExists("macro", zip)) {
          logger.debug(`${adventure.name} - Loading macro`);
          await this._importFile("macro", zip, adventure);
        }

        try {
          if (this._itemsToRevisit.length > 0) {
            let totalCount = this._itemsToRevisit.length;
            let currentCount = 0;

            await Helpers.asyncForEach(this._itemsToRevisit, async (item) => {
              const toTimer = setTimeout(() => {
                logger.warn(`Reference update timed out.`);
                const title = `Successful Import of ${adventure.name}`;
                new Dialog(
                  {
                    title: title,
                    content: {
                      adventure
                    },
                    buttons: {
                      two: {
                        label: "Ok",
                      },
                    },
                  },
                  {
                    classes: ["dialog", "adventure-import-export"],
                    template: "modules/ddb-importer/handlebars/adventure/import-complete.hbs",
                  }
                ).render(true);
                this.close();
              }, 60000);
              try {
                const obj = await fromUuid(item);
                // let rawData;
                let updatedData = {};
                switch (obj.documentName) {
                  case "Scene": {
                    const scene = JSON.parse(JSON.stringify(obj.data));
                    // this is a scene we need to update links to all items
                    logger.info(`Updating ${scene.name}, ${scene.tokens.length} tokens`);
                    await Helpers.asyncForEach(scene.tokens, async (token) => {
                      if (token.actorId) {
                        const sceneToken = scene.flags.ddb.tokens.find((t) => t._id === token._id);
                        delete sceneToken.scale;
                        const worldActor = game.actors.get(token.actorId);
                        if (worldActor) {
                          const tokenData = await worldActor.getTokenData();
                          delete tokenData.y;
                          delete tokenData.x;
                          const jsonTokenData = JSON.parse(JSON.stringify(tokenData));
                          const updateData = mergeObject(jsonTokenData, sceneToken);
                          logger.debug(`${token.name} token data for id ${token.actorId}`, updateData);
                          await obj.updateEmbeddedDocuments("Token", [updateData], { keepId: true });
                        }
                      }
                    });

                    // In 0.8.x the thumbs don't seem to be generated.
                    // This code would embed the thumbnail.
                    // Consider writing this out.
                    if (!obj.data.thumb) {
                      const thumbData = await obj.createThumbnail();
                      updatedData["thumb"] = thumbData.thumb;
                    }
                    await obj.update(updatedData);
                    break;
                  }
                  // no default
                }
              } catch (err) {
                logger.warn(`Error updating references for object ${item}`, err);
              }
              currentCount += 1;
              AdventureMunch._updateProgress(totalCount, currentCount, "References");
              clearTimeout(toTimer);
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-undef
          logger.warn(`Error during reference update for object ${item}`, err);
        }

        $(".ddb-overlay").toggleClass("import-invalid");

        const title = `Successful Import of ${adventure.name}`;
        new Dialog(
          {
            title: title,
            content: {
              adventure
            },
            buttons: {
              two: {
                label: "Ok",
              },
            },
          },
          {
            classes: ["dialog", "adventure-import-export"],
            template: "modules/ddb-importer/handlebars/adventure/import-complete.hbs",
          }
        ).render(true);

        // eslint-disable-next-line require-atomic-updates
        CONFIG.DDBI.ADVENTURE.TEMPORARY = {};
        this.close();
      } catch (err) {
        $(".ddb-overlay").toggleClass("import-invalid");
        ui.notifications.error(`There was an error importing ${importFilename}`);
        logger.error(`Error importing file ${importFilename}`, err);
        this.close();
      }
    }
  }

  static _folderExists(folder, zip) {
    const files = Object.values(zip.files).filter((file) => {
      return file.dir && file.name.toLowerCase().includes(folder);
    });

    return files.length > 0;
  }

  static _getFiles(folder, zip) {
    const files = Object.values(zip.files).filter((file) => {
      return !file.dir && file.name.split('.').pop() === 'json' && file.name.includes(`${folder}/`);
    });

    return files;
  }

  async _importCompendium(type, zip, adventure) {
    let totalCount = 0;
    let currentCount = 0;
    const typeName = type[0].toUpperCase() + type.slice(1);
    const dataFiles = AdventureMunch._getFiles(type, zip);
    logger.info(`Importing ${adventure.name} - ${typeName} (${dataFiles.length} items)`);
    totalCount = dataFiles.length;

    await Helpers.asyncForEach(dataFiles, async (file) => {
      const rawData = await zip.file(file.name).async("text");
      const data = JSON.parse(rawData);

      let pack = await Helpers.getCompendiumPack(data.info.entity, data.info.label);
      await pack.getIndex();

      totalCount += data.items.length;
      await Helpers.asyncForEach(data.items, async (item) => {
        let obj;
        let entry = pack.index.find((e) => e.name === item.name);

        item.flags.importid = item._id;

        if (item.img) {
          // eslint-disable-next-line require-atomic-updates
          item.img = await Helpers.importImage(item.img, zip, adventure);
        }
        if (item.thumb) {
          // eslint-disable-next-line require-atomic-updates
          item.thumb = await Helpers.importImage(item.thumb, zip, adventure);
        }
        if (item?.token?.img) {
          // eslint-disable-next-line require-atomic-updates
          item.token.img = await Helpers.importImage(item.token.img, zip, adventure);
        }

        if (item?.items?.length) {
          await Helpers.asyncForEach(data.items, async (i) => {
            if (i.img) {
              // eslint-disable-next-line require-atomic-updates
              i.img = await Helpers.importImage(i.img, zip, adventure);
            }
          });
        }

        switch (data.info.entity) {
          case "Item":
            obj = new Item(item, { temporary: true });
            break;
          case "Actor":
            obj = new Actor(item, { temporary: true });
            break;
          case "Scene":
            obj = new Scene(item, { temporary: true });
            break;
          case "JournalEntry":
            obj = new JournalEntry(item, { temporary: true });
            break;
          case "Macro":
            obj = new Macro(item, { temporary: true });
            break;
          case "RollTable":
            await Helpers.asyncForEach(item.results, async (result) => {
              // eslint-disable-next-line require-atomic-updates
              result.img = await Helpers.importImage(result.img, zip, adventure);
            });
            obj = new RollTable(item, { temporary: true });
            break;
          case "Playlist":
            await Helpers.asyncForEach(item.sounds, async (sound) => {
              // eslint-disable-next-line require-atomic-updates
              sound.path = await Helpers.importImage(sound.path, zip, adventure);
            });
            obj = new Playlist(item, { temporary: true });
            break;
          // no default
        }

        if (!entry) {
          let compendiumItem = await pack.importDocument(obj);

          if (JSON.stringify(item).match(this.pattern) || JSON.stringify(item).match(this.altpattern)) {
            this._itemsToRevisit.push(`Compendium.${pack.metadata.package}.${pack.metadata.name}.${compendiumItem.data._id}`);
          }
        }
        currentCount += 1;
        AdventureMunch._updateProgress(totalCount, currentCount, typeName);
      });
      currentCount += 1;
      AdventureMunch._updateProgress(totalCount, currentCount, typeName);
    });
  }

  // import a scene file
  async _importRenderedSceneFile(adventure, typeName, data, zip, needRevisit, overwriteIds, overwriteEntity) {
    if (!Helpers.findEntityByImportId("scenes", data._id) || overwriteEntity) {
      await Helpers.asyncForEach(data.tokens, async (token) => {
        // eslint-disable-next-line require-atomic-updates
        if (token.img) token.img = await Helpers.importImage(token.img, zip, adventure);
      });

      await Helpers.asyncForEach(data.sounds, async (sound) => {
        // eslint-disable-next-line require-atomic-updates
        sound.path = await Helpers.importImage(sound.path, zip, adventure);
      });

      await Helpers.asyncForEach(data.notes, async (note) => {
        // eslint-disable-next-line require-atomic-updates
        note.icon = await Helpers.importImage(note.icon, zip, adventure, true);
      });

      await Helpers.asyncForEach(data.tiles, async (tile) => {
        // eslint-disable-next-line require-atomic-updates
        tile.img = await Helpers.importImage(tile.img, zip, adventure);
      });

      if (overwriteEntity) await Scene.delete([data._id]);
      const scene = await Scene.create(data, { keepId: true });
      this._itemsToRevisit.push(`Scene.${scene.data._id}`);
    }
  }

  async _importRenderedFile(adventure, typeName, data, zip, needRevisit, overwriteIds) {
    const overwriteEntity = overwriteIds.includes(data._id);
    switch (typeName) {
      case "Scene": {
        await this._importRenderedSceneFile(adventure, typeName, data, zip, needRevisit, overwriteIds, overwriteEntity);
        break;
      }
      case "Actor":
        if (!Helpers.findEntityByImportId("actors", data._id)) {
          let actor = await Actor.create(data, { keepId: true });
          await actor.update({ [`data.token.actorId`]: actor.data._id });
          if (needRevisit) {
            this._itemsToRevisit.push(`Actor.${actor.data._id}`);
          }
        }
      break;
      case "Item":
        if (!Helpers.findEntityByImportId("items", data._id)) {
          let item = await Item.create(data, { keepId: true });
          if (needRevisit) {
            this._itemsToRevisit.push(`Item.${item.data._id}`);
          }
        }
      break;
      case "JournalEntry":
        if (!Helpers.findEntityByImportId("journal", data._id)) {
          let journal = await JournalEntry.create(data, { keepId: true });
          if (needRevisit) {
            this._itemsToRevisit.push(`JournalEntry.${journal.data._id}`);
          }
        }
      break;
      case "RollTable":
        if (!Helpers.findEntityByImportId("tables", data._id)) {
          let rolltable = await RollTable.create(data, { keepId: true });
          if (needRevisit) {
            this._itemsToRevisit.push(`RollTable.${rolltable.data._id}`);
          }
        }
      break;
      case "Playlist":
        if (!Helpers.findEntityByImportId("playlists", data._id)) {
          data.name = `${adventure.name}.${data.name}`;
          await Playlist.create(data, { keepId: true });
        }
      break;
      case "Macro":
        if (!Helpers.findEntityByImportId("macros", data._id)) {
          let macro = await Macro.create(data, { keepId: true });
          if (needRevisit) {
            this._itemsToRevisit.push(`Macro.${macro.data._id}`);
          }
        }
      break;
      // no default
    }
  }

  static async _loadMissingDocuments(type, docIds) {
    return new Promise((resolve) => {
      if (docIds && docIds.length > 0) {
        logger.debug(`Importing missing ${type}s from DDB`, docIds);
        AdventureMunch._progressNote(`Importing ${docIds.length} missing ${type}s from DDB`);
        switch (type) {
          case "item":
            resolve(parseItems(docIds));
            break;
          case "monster": {
            const tier = game.settings.get("ddb-importer", "patreon-tier");
            const tiers = getPatreonTiers(tier);
            if (tiers.all) {
              resolve(parseCritters(docIds));
            } else {
              resolve([]);
            }
            break;
          }
          case "spell":
            resolve(parseSpells(docIds));
            break;
          // no default
        }
      } else {
        resolve([]);
      }
    });
  }

  static async _getCompendiumIndex(type) {
    return new Promise((resolve) => {
      const compendium = getCompendiumType(type);
      const fields = (type === "monster")
        ? ["flags.ddbimporter.id"]
        : ["flags.ddbimporter.definitionId"];

      const compendiumIndex = compendium.getIndex({ fields: fields });
      resolve(compendiumIndex);
    });
  }

  static async _checkForMissingDocuments(type, ids) {
    const index = await AdventureMunch._getCompendiumIndex(type);

    return new Promise((resolve) => {
      const missingIds = ids.filter((id) => {
        switch (type) {
          case "monster":
            return !index.some((i) => i.flags?.ddbimporter?.id && String(i.flags.ddbimporter.id) == id);
          case "spell":
          case "item":
            return !index.some((i) => i.flags?.ddbimporter?.definitionId && String(i.flags.ddbimporter.definitionId) == id);
          // no default
        }
        return false;
      });
      const missingDocuments = AdventureMunch._loadMissingDocuments(type, missingIds);
      resolve(missingDocuments);
    });
  }

  static async _linkExistingActorTokens(tokens) {
    const monsterIndex = await AdventureMunch._getCompendiumIndex("monster");

    const newTokens = tokens.map((token) => {
      const monsterHit = monsterIndex.find((monster) =>
        monster.flags?.ddbimporter?.id && token.flags.ddbActorFlags?.id &&
        monster.flags.ddbimporter.id === token.flags.ddbActorFlags.id);
      if (monsterHit) {
        token.flags.compendiumActorId = monsterHit._id;
      }
      return token;
    });

    return newTokens;
  }

  static _foundryCompendiumReplace(text) {
    // replace the ddb:// entries with known compendium look ups if we have them
    // ddb://spells
    // ddb://magicitems || weapons || adventuring-gear || armor
    // ddb://monsters

    let doc = utils.htmlToDoc(text);

    const lookups = CONFIG.DDBI.ADVENTURE.TEMPORARY.lookups.lookups;

    for (const lookupKey in COMPENDIUM_MAP) {
      const compendiumLinks = doc.querySelectorAll(`a[href*="ddb://${lookupKey}/"]`);
      logger.debug(`replacing ${lookupKey} references`, compendiumLinks);

      const lookupRegExp = new RegExp(`ddb://${lookupKey}/([0-9]*)`);
      compendiumLinks.forEach((node) => {
        const lookupMatch = node.outerHTML.match(lookupRegExp);
        const lookupValue = lookups[COMPENDIUM_MAP[lookupKey]];

        if (lookupValue) {
          const lookupEntry = lookupValue.find((e) => e.id == lookupMatch[1]);
          if (lookupEntry) {
            const documentRef = lookupEntry.documentName ? lookupEntry.documentName : lookupEntry._id;
            doc.body.innerHTML = doc.body.innerHTML.replace(node.outerHTML, `@Compendium[${lookupEntry.compendium}.${documentRef}]{${node.textContent}}`);
          } else {
            logger.warn(`NO Lookup Compendium Entry for ${node.outerHTML}`);
          }
        }
      });
    }

    // vehicles - not yet handled, links to DDB
    const compendiumLinks = doc.querySelectorAll("a[href*=\"ddb://vehicles/\"]");
    const lookupRegExp = /ddb:\/\/vehicles\/([0-9]*)/g;
    compendiumLinks.forEach((node) => {
      const target = node.outerHTML;
      const lookupMatch = node.outerHTML.match(lookupRegExp);
      const lookupValue = lookups["vehicles"];
      if (lookupMatch) {
        const lookupEntry = lookupValue.find((e) => e.id == lookupMatch[1]);
        if (lookupEntry) {
          node.setAttribute("href", `https://www.dndbeyond.com${lookupEntry.url}`);
          doc.body.innerHTML = doc.body.innerHTML.replace(target, node.outerHTML);
        } else {
          logger.warn(`NO Vehicle Lookup Entry for ${node.outerHTML}`);
        }
      } else {
        logger.warn(`NO Vehicle Lookup Match for ${node.outerHTML}`);
      }
    });

    // final replace in case of failure
    // there is a chance that the adventure references items or monsters we don't have access to
    // in this case attempt to link to DDB instead of compendium doc
    for (const lookupKey in COMPENDIUM_MAP) {
      const compendiumLinks = doc.querySelectorAll(`a[href*="ddb://${lookupKey}/"]`);
      logger.debug(`final replace for missing ${lookupKey} references`, compendiumLinks);

      compendiumLinks.forEach((node) => {
        const target = node.outerHTML;
        const ddbStub = DDB_MAP[lookupKey];
        const ddbNameGuess = node.textContent.toLowerCase().replace(" ", "-").replace(/[^0-9a-z-]/gi, '');
        logger.warn(`No Compendium Entry for ${node.outerHTML} attempting to guess a link to DDB`);

        node.setAttribute("href", `https://www.dndbeyond.com/${ddbStub}/${ddbNameGuess}`);
        doc.body.innerHTML = doc.body.innerHTML.replace(target, node.outerHTML);
      });
    }

    return doc.body.innerHTML;
  }

  static async _linkDDBActors(tokens) {
    const linkedExistingTokens = await AdventureMunch._linkExistingActorTokens(tokens);
    const newTokens = linkedExistingTokens
      .filter((token) => token.flags.ddbActorFlags?.id && token.flags.compendiumActorId);

    return Promise.all(newTokens);
  }

  static async _generateTokenActors(scene) {
    const monsterCompendium = checkMonsterCompendium();

    const tokens = await AdventureMunch._linkDDBActors(scene.tokens);

    const neededActors = tokens
      .map((token) => {
        return { name: token.name, ddbId: token.flags.ddbActorFlags.id, actorId: token.actorId, compendiumId: token.flags.compendiumActorId, folderId: token.flags.actorFolderId };
      })
      .filter((obj, pos, arr) => {
        // we only need to create 1 actor per actorId
        return arr.map((mapObj) => mapObj["actorId"]).indexOf(obj["actorId"]) === pos;
      });

    logger.debug("Trying to import actors from compendium", neededActors);
    await Helpers.asyncForEach(neededActors, async (actor) => {
      let worldActor = game.actors.get(actor.actorId);
      if (!worldActor) {
        logger.info(`Importing actor ${actor.name} with DDB ID ${actor.ddbId} from ${monsterCompendium.metadata.name} with id ${actor.compendiumId}`);
        try {
          worldActor = await game.actors.importFromCompendium(monsterCompendium, actor.compendiumId, { _id: actor.actorId, folder: actor.folderId }, { keepId: true });
        } catch (err) {
          logger.error(err);
          logger.warn(`Unable to import actor ${actor.name} with id ${actor.compendiumId} from DDB Compendium`);
          logger.debug(`Failed on: game.actors.importFromCompendium(monsterCompendium, "${actor.compendiumId}", { _id: "${actor.actorId}", folder: "${actor.folderId}" }, { keepId: true });`);
        }
      }
    });

    logger.debug("Actors transferred from compendium to world.");

  }

  static getImportType(type) {
    const typeName = type[0].toUpperCase() + type.slice(1);
    let importType = typeName;

    switch (type) {
      case "journal":
        importType = "JournalEntry";
        break;
      case "table":
        importType = "RollTable";
        break;
      default:
        importType = typeName;
        break;
    }

    return importType;
  }

  // check the document for version data and for update info to see if we can replace it
  static _extractDocumentVersionData(newDoc, existingDoc, ddbIVersion) {
    // do we have versioned metadata?
    if (newDoc?.flags?.ddb?.versions?.ddbMetaData?.lastUpdate) {
      // check old data, it might not exist
      const oldDDBMetaDataVersions = existingDoc.data?.flags?.ddb?.versions?.ddbMetaData?.lastUpdate
        ? existingDoc.data.flags.ddb.versions.ddbMetaData
        : {
          lastUpdate: "0.0.1",
          drawings: "0.0.1",
          notes: "0.0.1",
          tokens: "0.0.1",
          walls: "0.0.1",
          lights: "0.0.1",
        };
      const oldDDBImporterVersion = existingDoc.data?.flags?.ddb?.versions?.ddbImporter
      ? existingDoc.data.flags.ddb.versions.ddbImporter
      : "2.0.1";
      const oldAdventureMuncherVersion = existingDoc.data?.flags?.ddb?.versions?.adventureMuncher
      ? existingDoc.data.flags.ddb.versions.adventureMuncher
      : "0.3.0";
      const oldVersions = { ddbImporter: oldDDBImporterVersion, ddbMetaData: oldDDBMetaDataVersions, adventureMuncher: oldAdventureMuncherVersion };

      const documentVersions = newDoc.flags.ddb.versions;
      const importerVersionChanged = isNewerVersion(ddbIVersion, oldVersions["ddbImporter"]);
      const metaVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["lastUpdate"], oldVersions["ddbMetaData"]["lastUpdate"]);
      const muncherVersionChanged = isNewerVersion(documentVersions["adventureMuncher"], oldVersions["adventureMuncher"]);

      if (importerVersionChanged || metaVersionChanged || muncherVersionChanged) {
        newDoc.oldVersions = oldVersions;
        newDoc.importerVersionChanged = importerVersionChanged;
        newDoc.metaVersionChanged = metaVersionChanged;
        newDoc.muncherVersionChanged = muncherVersionChanged;
        newDoc.drawingVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["drawings"], oldVersions["ddbMetaData"]["drawings"]);
        newDoc.noteVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["notes"], oldVersions["ddbMetaData"]["notes"]);
        newDoc.tokenVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["tokens"], oldVersions["ddbMetaData"]["tokens"]);
        newDoc.wallVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["walls"], oldVersions["ddbMetaData"]["walls"]);
        newDoc.lightVersionChanged = isNewerVersion(documentVersions["ddbMetaData"]["lights"], oldVersions["ddbMetaData"]["lights"]);
      }
    }
    return newDoc;
  }

  async _checkForDataUpdates(type, zip, adventure) {
    const importType = AdventureMunch.getImportType(type);
    const dataFiles = AdventureMunch._getFiles(type, zip);

    logger.info(`Checking ${adventure.name} - ${importType} (${dataFiles.length} for updates)`);

    let fileData = [];
    let hasVersions = false;
    const moduleInfo = game.modules.get("ddb-importer").data;
    const installedVersion = moduleInfo.version;

    await Helpers.asyncForEach(dataFiles, async (file) => {
      const raw = await zip.file(file.name).async("text");
      const json = JSON.parse(raw);
      if (!hasVersions && json?.flags?.ddb?.versions) {
        hasVersions = true;
      }
      switch (importType) {
        case "Scene": {
          const existingScene = await game.scenes.find((item) => item.data._id === json._id);
          if (existingScene) {
            const scene = AdventureMunch._extractDocumentVersionData(json, existingScene, installedVersion);
            if (scene.importerVersionChanged || scene.metaVersionChanged || scene.muncherVersionChanged) {
              fileData.push(scene);
            }
          }
          break;
        }
        // no default
      }
    });

    return new Promise((resolve) => {
      if (hasVersions && fileData.length > 0) {
        new Dialog(
          {
            title: `${importType} updates`,
            content: {
              "dataType": type,
              "dataTypeDisplay": importType,
              "fileData": fileData,
              "cssClass": "import-data-updates"
            },
            buttons: {
              confirm: {
                label: "Confirm",
                callback: async () => {
                  const formData = $('.import-data-updates').serializeArray();
                  let ids = [];
                  let dataType = "";
                  for (let i = 0; i < formData.length; i++) {
                    const key = formData[i].name;
                    if (key.startsWith("new_")) {
                      ids.push(key.substr(4));
                    } else if (key === "type") {
                      dataType = formData[i].value;
                    }
                  }
                  resolve(this._importFile(dataType, zip, adventure, ids));
                }
              },
            },
            default: "confirm",
            close: async () => {
              resolve(this._importFile(type, zip, adventure));
            },
          },
          {
            width: 700,
            classes: ["dialog", "adventure-import-updates"],
            template: "modules/ddb-importer/handlebars/adventure/import-updates.hbs",
          }
        ).render(true);
      } else {
        resolve(this._importFile(type, zip, adventure));
      }
    });

  }

  async _importFile(type, zip, adventure, overwriteIds = []) {
    let totalCount = 0;
    let currentCount = 0;

    logger.info(`IDs to overwrite of type ${type}: ${JSON.stringify(overwriteIds)}`);

    const importType = AdventureMunch.getImportType(type);
    const dataFiles = AdventureMunch._getFiles(type, zip);

    logger.info(`Importing ${adventure.name} - ${importType} (${dataFiles.length} items)`);

    totalCount = dataFiles.length;

    await Helpers.asyncForEach(dataFiles, async (file) => {
      const rawdata = await zip.file(file.name).async("text");
      const data = JSON.parse(rawdata);

      let needRevisit = false;

      // let pattern = /(\@[a-z]*)(\[)([a-z0-9]*|[a-z0-9\.]*)(\])/gmi
      if (rawdata.match(this.pattern) || rawdata.match(this.altpattern)) {
        needRevisit = true;
      }

      if (data.img) {
        // eslint-disable-next-line require-atomic-updates
        data.img = await Helpers.importImage(data.img, zip, adventure);
      }
      if (data.thumb) {
        // eslint-disable-next-line require-atomic-updates
        data.thumb = await Helpers.importImage(data.thumb, zip, adventure);
      }
      if (data?.token?.img) {
        if (data?.token?.randomImg) {
          const imgFilepaths = data.token.img.split("/");
          const imgFilename = (imgFilepaths.reverse())[0];
          const imgFilepath = data.token.img.replace(imgFilename, "");

          const filesToUpload = Object.values(zip.files).filter((file) => {
            return !file.dir && file.name.includes(imgFilepath);
          });

          let adventurePath = (adventure.name).replace(/[^a-z0-9]/gi, '_');

          data.token.img = `${this._importPathData.current}/${adventurePath}/${data.token.img}`;

          if (filesToUpload.length > 0) {
            totalCount += filesToUpload.length;

            await Helpers.asyncForEach(filesToUpload, async (file) => {
              await Helpers.importImage(file.name, zip, adventure);
              currentCount += 1;
              AdventureMunch._updateProgress(totalCount, currentCount, importType);
            });
          }

        } else {
          // eslint-disable-next-line require-atomic-updates
          data.token.img = await Helpers.importImage(data.token.img, zip, adventure);
        }
      }

      if (data?.items?.length) {
        await Helpers.asyncForEach(data.items, async (item) => {
          if (item.img) {
            // eslint-disable-next-line require-atomic-updates
            item.img = await Helpers.importImage(item.img, zip, adventure);
          }
        });
      }

      if (importType === "Scene") {
        if (data.tokens) {
          await AdventureMunch._generateTokenActors(data);
        }
      } else if (importType === "Playlist") {
        await Helpers.asyncForEach(data.sounds, async (sound) => {
          if (sound.path) {
            // eslint-disable-next-line require-atomic-updates
            sound.path = await Helpers.importImage(sound.path, zip, adventure);
          }
        });
      } else if (importType === "RollTable") {
        await Helpers.asyncForEach(data.results, async (result) => {
          if (result.img) {
            // eslint-disable-next-line require-atomic-updates
            result.img = await Helpers.importImage(result.img, zip, adventure);
          }
          if (result.resultId) {
            needRevisit = true;
          }
          logger.debug(`Updating DDB links for ${data.name}`);
          // eslint-disable-next-line require-atomic-updates
          data.text = AdventureMunch._foundryCompendiumReplace(data.text);
        });
      } else if (importType === "JournalEntry" && data.content) {
        const journalImages = Helpers.reMatchAll(/(src|href)="(?!http(?:s*):\/\/)([\w0-9\-._~%!$&'()*+,;=:@/]*)"/, data.content);
        if (journalImages) {
          await Helpers.asyncForEach(journalImages, async (result) => {
            const path = await Helpers.importImage(result[2], zip, adventure);
            data.content = data.content.replace(result[0], `${result[1]}="${path}"`);
          });
        }
        logger.debug(`Updating DDB links for ${data.name}`);
        data.content = AdventureMunch._foundryCompendiumReplace(data.content);
      }

      data.flags.importid = data._id;

      if (importType !== "Playlist" && importType !== "Compendium") {
        if (CONFIG.DDBI.ADVENTURE.TEMPORARY.folders[data.folder]) {
          logger.debug(`Adding data to subfolder importkey = ${data.folder}, folder = ${CONFIG.DDBI.ADVENTURE.TEMPORARY.folders[data.folder]}`);
          data.folder = CONFIG.DDBI.ADVENTURE.TEMPORARY.folders[data.folder];
        } else {
          logger.debug(`Adding data to subfolder importkey = ${data.folder}, folder = ${CONFIG.DDBI.ADVENTURE.TEMPORARY.folders["null"]}`);
          if (adventure?.options?.folders) {
            data.folder = CONFIG.DDBI.ADVENTURE.TEMPORARY.folders["null"];
          } else {
            data.folder = CONFIG.DDBI.ADVENTURE.TEMPORARY.folders[importType];
          }
        }
      }

      await this._importRenderedFile(adventure, importType, data, zip, needRevisit, overwriteIds);

      currentCount += 1;
      AdventureMunch._updateProgress(totalCount, currentCount, importType);
    });


  }

  static _updateProgress(total, count, type) {
    const localizedType = `dbb-importer.label.${type}`;
    $(".import-progress-bar")
      .width(`${Math.trunc((count / total) * 100)}%`)
      .html(`<span>${game.i18n.localize("dbb-importer.label.Working")} (${game.i18n.localize(localizedType)})...</span>`);
  }

  static _progressNote(note) {
    $(".import-progress-bar")
      .html(`<span>${game.i18n.localize("dbb-importer.label.Working")} (${note})...</span>`);
  }
}
