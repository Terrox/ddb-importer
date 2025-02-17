import utils from "../../lib/utils.js";
import DDBHelper from "../../lib/DDBHelper.js";

// Import parsing functions
import { getLookups } from "./metadata.js";
import { fixSpells } from "./special.js";
import { parseSpell } from "./parseSpell.js";
import { getSpellCastingAbility, hasSpellCastingAbility, convertSpellCastingAbilityId } from "./ability.js";
import logger from "../../logger.js";

export function getCharacterSpells(ddb, character) {
  let items = [];
  const proficiencyModifier = character.system.attributes.prof;
  const lookups = getLookups(ddb.character);

  logger.debug("Character spell lookups", lookups);
  const characterAbilities = character.flags.ddbimporter.dndbeyond.effectAbilities;

  const healingBoost = DDBHelper.filterBaseModifiers(ddb, "bonus", "spell-group-healing").reduce((a, b) => a + b.value, 0);

  // each class has an entry here, each entry has spells
  // we loop through each class and process
  ddb.character.classSpells.forEach((playerClass) => {
    const classInfo = ddb.character.classes.find((cls) => cls.id === playerClass.characterClassId);
    const spellCastingAbility = getSpellCastingAbility(classInfo);
    const abilityModifier = utils.calculateModifier(characterAbilities[spellCastingAbility].value);

    logger.debug("Spell parsing, class info", classInfo);

    const cantripBoost
      = DDBHelper.getChosenClassModifiers(ddb).filter(
        (mod) =>
          mod.type === "bonus"
          && mod.subType === `${classInfo.definition.name.toLowerCase()}-cantrip-damage`
          && (mod.restriction === null || mod.restriction === "")
      ).length > 0;

    // parse spells chosen as spellcasting (playerClass.spells)
    playerClass.spells.forEach((spell) => {
      if (!spell.definition) return;
      // add some data for the parsing of the spells into the data structure
      spell.flags = {
        ddbimporter: {
          dndbeyond: {
            lookup: "classSpell",
            class: classInfo.definition.name,
            level: classInfo.level,
            characterClassId: playerClass.characterClassId,
            spellLevel: spell.definition.level,
            // spellSlots: character.system.spells,
            ability: spellCastingAbility,
            mod: abilityModifier,
            dc: 8 + proficiencyModifier + abilityModifier,
            cantripBoost: cantripBoost,
            overrideDC: false,
            id: spell.id,
            entityTypeId: spell.entityTypeId,
            healingBoost: healingBoost,
            usesSpellSlot: spell.usesSpellSlot,
          },
        },
        "spell-class-filter-for-5e": {
          parentClass: classInfo.definition.name.toLowerCase(),
        },
        // "spellbook-assistant-manager": {
        //   class: classInfo.definition.name.toLowerCase(),
        // }
      };

      // Check for duplicate spells, normally domain ones
      // We will import spells from a different class that are the same though
      // as they may come from with different spell casting mods
      const parsedSpell = parseSpell(spell, character);
      const duplicateSpell = items.findIndex(
        (existingSpell) => {
          const existingName = (existingSpell.flags.ddbimporter.originalName ? existingSpell.flags.ddbimporter.originalName : existingSpell.name);
          const parsedName = (parsedSpell.flags.ddbimporter.originalName ? parsedSpell.flags.ddbimporter.originalName : parsedSpell.name);
          // some spells come from different classes but end up having the same ddb id
          const classIdMatch = (classInfo.definition.name === existingSpell.flags.ddbimporter.dndbeyond.class || spell.id === existingSpell.flags.ddbimporter.dndbeyond.id);
          return existingName === parsedName && classIdMatch;
        });
      const duplicateItem = items[duplicateSpell];
      if (!duplicateItem) {
        items.push(parsedSpell);
      } else if (spell.alwaysPrepared || parsedSpell.system.preparation.mode === "always"
        || (spell.alwaysPrepared === duplicateItem.alwaysPrepared && parsedSpell.system.preparation.mode === duplicateItem.system.preparation.mode && parsedSpell.prepared && !duplicateItem.prepared)) {
        // if our new spell is always known we overwrite!
        // it's probably domain
        items[duplicateSpell] = parsedSpell;
      } else {
        // we'll emit a console message if it doesn't match this case for future debugging
        logger.info(`Duplicate Spell ${spell.definition.name} detected in class ${classInfo.definition.name}.`);
      }
    });
  });

  // Parse any spells granted by class features, such as Barbarian Totem
  ddb.character.spells.class.forEach((spell) => {
    if (!spell.definition) return;
    // If the spell has an ability attached, use that
    let spellCastingAbility = undefined;
    const featureId = DDBHelper.determineActualFeatureId(ddb, spell.componentId);
    const classInfo = lookups.classFeature.find((clsFeature) => clsFeature.id == featureId);

    logger.debug("Class spell parsing, class info", classInfo);
    // Sometimes there are spells here which don't have an class Info
    // this seems to be part of the optional tasha's rules, lets not parse for now
    // as ddb implementation is not yet finished
    // / options.class.[].definition.id
    if (!classInfo) {
      logger.warn(`Unable to add ${spell.definition.name}`);
    }
    if (!classInfo) return;
    let klass = DDBHelper.getClassFromOptionID(ddb, spell.componentId);

    if (!klass) klass = DDBHelper.findClassByFeatureId(ddb, spell.componentId);

    logger.debug("Class spell, class found?", klass);

    if (hasSpellCastingAbility(spell.spellCastingAbilityId)) {
      spellCastingAbility = convertSpellCastingAbilityId(spell.spellCastingAbilityId);
    } else if (klass) {
      spellCastingAbility = getSpellCastingAbility(klass);
      // force these spells to always be prepared
      spell.alwaysPrepared = true;
    } else {
      // if there is no ability on spell, we default to wis
      spellCastingAbility = "wis";
    }

    const abilityModifier = utils.calculateModifier(characterAbilities[spellCastingAbility].value);

    // add some data for the parsing of the spells into the data structure
    spell.flags = {
      ddbimporter: {
        dndbeyond: {
          class: (klass) ? klass.definition.name : undefined,
          lookup: "classFeature",
          lookupName: classInfo.name,
          lookupId: classInfo.id,
          level: character.flags.ddbimporter.dndbeyond.totalLevels,
          ability: spellCastingAbility,
          mod: abilityModifier,
          dc: 8 + proficiencyModifier + abilityModifier,
          overrideDC: false,
          id: spell.id,
          entityTypeId: spell.entityTypeId,
          healingBoost: healingBoost,
          usesSpellSlot: spell.usesSpellSlot,
        },
      },
    };

    // Check for duplicate spells, normally domain ones
    // We will import spells from a different class that are the same though
    // as they may come from with different spell casting mods
    const duplicateSpell = items.findIndex(
      (existingSpell) =>
        (existingSpell.flags.ddbimporter.originalName ? existingSpell.flags.ddbimporter.originalName : existingSpell.name) === spell.definition.name
        && klass
        && klass.definition.name === existingSpell.flags.ddbimporter.dndbeyond.class
        && spell.usesSpellSlot && existingSpell.flags.ddbimporter.dndbeyond.usesSpellSlot
    );
    if (!items[duplicateSpell]) {
      items.push(parseSpell(spell, character));
    } else if (spell.alwaysPrepared) {
      // if our new spell is always known we overwrite!
      // it's probably domain
      items[duplicateSpell] = parseSpell(spell, character);
    } else {
      // we'll emit a console message if it doesn't match this case for future debugging
      logger.info(`Duplicate Spell ${spell.definition.name} detected in class ${classInfo.name}.`);
    }
  });

  // Race spells are handled slightly differently
  ddb.character.spells.race.forEach((spell) => {
    if (!spell.definition) return;
    // for race spells the spell spellCastingAbilityId is on the spell
    // if there is no ability on spell, we default to wis
    let spellCastingAbility = "wis";
    if (hasSpellCastingAbility(spell.spellCastingAbilityId)) {
      spellCastingAbility = convertSpellCastingAbilityId(spell.spellCastingAbilityId);
    }

    const abilityModifier = utils.calculateModifier(characterAbilities[spellCastingAbility].value);

    let raceInfo = lookups.race.find((rc) => rc.id === spell.componentId);

    if (!raceInfo) {
      // for some reason we haven't matched the race option id with the spell
      // this happens with at least the SCAG optional spells casting half elf
      raceInfo = {
        name: "Racial spell",
        id: spell.componentId,
      };
    }

    // add some data for the parsing of the spells into the data structure
    spell.flags = {
      ddbimporter: {
        dndbeyond: {
          lookup: "race",
          lookupName: raceInfo.name,
          lookupId: raceInfo.id,
          race: ddb.character.race.fullName,
          level: spell.castAtLevel,
          ability: spellCastingAbility,
          mod: abilityModifier,
          dc: 8 + proficiencyModifier + abilityModifier,
          overrideDC: false,
          id: spell.id,
          entityTypeId: spell.entityTypeId,
          healingBoost: healingBoost,
          usesSpellSlot: spell.usesSpellSlot,
        },
      },
    };

    if (spell.alwaysPrepared && spell.limitedUse) {
      const dups = ddb.character.spells.race.filter((otherSpell) => otherSpell.definition.name === spell.definition.name).length > 1;
      const duplicateSpell = items.findIndex(
        (existingSpell) =>
          (existingSpell.flags.ddbimporter.originalName ? existingSpell.flags.ddbimporter.originalName : existingSpell.name) === spell.definition.name
          && existingSpell.flags.ddbimporter.dndbeyond.usesSpellSlot
      );
      if (!dups && !items[duplicateSpell]) {
        // also parse spell as non-limited use
        let unlimitedSpell = duplicate(spell);
        unlimitedSpell.limitedUse = null;
        unlimitedSpell.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.granted = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.lookup = "race";
        delete unlimitedSpell.id;
        delete unlimitedSpell.flags.ddbimporter.dndbeyond.id;
        items.push(parseSpell(unlimitedSpell, character));
      }
    }

    items.push(parseSpell(spell, character));
  });

  // feat spells are handled slightly differently
  ddb.character.spells.feat.forEach((spell) => {
    if (!spell.definition) return;
    // If the spell has an ability attached, use that
    // if there is no ability on spell, we default to wis
    let spellCastingAbility = "wis";
    if (hasSpellCastingAbility(spell.spellCastingAbilityId)) {
      spellCastingAbility = convertSpellCastingAbilityId(spell.spellCastingAbilityId);
    }

    const abilityModifier = utils.calculateModifier(characterAbilities[spellCastingAbility].value);

    let featInfo = lookups.feat.find((ft) => ft.id === spell.componentId);

    if (!featInfo) {
      // for some reason we haven't matched the feat option id with the spell
      // we fiddle the result
      featInfo = {
        name: "Feat option spell",
        id: spell.componentId,
      };
    }

    // add some data for the parsing of the spells into the data structure
    spell.flags = {
      ddbimporter: {
        dndbeyond: {
          lookup: "feat",
          lookupName: featInfo.name,
          lookupId: featInfo.id,
          level: spell.castAtLevel,
          ability: spellCastingAbility,
          mod: abilityModifier,
          dc: 8 + proficiencyModifier + abilityModifier,
          overrideDC: false,
          id: spell.id,
          entityTypeId: spell.entityTypeId,
          healingBoost: healingBoost,
          usesSpellSlot: spell.usesSpellSlot,
        },
      },
    };

    if (spell.alwaysPrepared && spell.limitedUse) {
      const dups = ddb.character.spells.feat.filter((otherSpell) => otherSpell.definition.name === spell.definition.name).length > 1;
      const duplicateSpell = items.findIndex(
        (existingSpell) =>
          (existingSpell.flags.ddbimporter.originalName ? existingSpell.flags.ddbimporter.originalName : existingSpell.name) === spell.definition.name
          && existingSpell.flags.ddbimporter.dndbeyond.usesSpellSlot
      );
      if (!dups && !items[duplicateSpell]) {
        // also parse spell as non-limited use
        let unlimitedSpell = duplicate(spell);
        unlimitedSpell.limitedUse = null;
        unlimitedSpell.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.lookup = "feat";
        unlimitedSpell.flags.ddbimporter.dndbeyond.granted = true;
        delete unlimitedSpell.id;
        delete unlimitedSpell.flags.ddbimporter.dndbeyond.id;
        items.push(parseSpell(unlimitedSpell, character));
      }
    }

    items.push(parseSpell(spell, character));
  });

  // background spells are handled slightly differently
  if (!ddb.character.spells.background) ddb.character.spells.background = [];
  ddb.character.spells.background.forEach((spell) => {
    if (!spell.definition) return;
    // If the spell has an ability attached, use that
    // if there is no ability on spell, we default to wis
    let spellCastingAbility = "wis";
    if (hasSpellCastingAbility(spell.spellCastingAbilityId)) {
      spellCastingAbility = convertSpellCastingAbilityId(spell.spellCastingAbilityId);
    }

    const abilityModifier = utils.calculateModifier(characterAbilities[spellCastingAbility].value);

    // add some data for the parsing of the spells into the data structure
    spell.flags = {
      ddbimporter: {
        dndbeyond: {
          lookup: "background",
          lookupName: "Background",
          level: spell.castAtLevel,
          ability: spellCastingAbility,
          mod: abilityModifier,
          dc: 8 + proficiencyModifier + abilityModifier,
          overrideDC: false,
          id: spell.id,
          entityTypeId: spell.entityTypeId,
          healingBoost: healingBoost,
          usesSpellSlot: spell.usesSpellSlot,
        },
      },
    };

    if (spell.alwaysPrepared && spell.limitedUse) {
      const dups = ddb.character.spells.background.filter((otherSpell) => otherSpell.definition.name === spell.definition.name).length > 1;
      const duplicateSpell = items.findIndex(
        (existingSpell) =>
          (existingSpell.flags.ddbimporter.originalName ? existingSpell.flags.ddbimporter.originalName : existingSpell.name) === spell.definition.name
          && existingSpell.flags.ddbimporter.dndbeyond.usesSpellSlot
      );
      if (!dups && !items[duplicateSpell]) {
        // also parse spell as non-limited use
        let unlimitedSpell = duplicate(spell);
        unlimitedSpell.limitedUse = null;
        unlimitedSpell.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.usesSpellSlot = true;
        unlimitedSpell.flags.ddbimporter.dndbeyond.lookup = "background";
        unlimitedSpell.flags.ddbimporter.dndbeyond.granted = true;
        delete unlimitedSpell.id;
        delete unlimitedSpell.flags.ddbimporter.dndbeyond.id;
        items.push(parseSpell(unlimitedSpell, character));
      }
    }

    items.push(parseSpell(spell, character));
  });

  if (items) fixSpells(ddb, items);

  return items;
}

