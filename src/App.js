import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import './App.css';

function App() {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMedicine, setSelectedMedicine] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [matchedGenerics, setMatchedGenerics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drugFilter, setDrugFilter] = useState('all'); // 'all', 'branded', 'generic'
  
  // Data states
  const [medicationsData, setMedicationsData] = useState([]);
  const [enrichedManifest, setEnrichedManifest] = useState(null);
  const [descClassMap, setDescClassMap] = useState({});
  const chunkCacheRef = useRef(new Map()); // filename -> array (cached)
  // openFDA not loaded at runtime; rely on enriched fdaMatches
  const [searchIndex, setSearchIndex] = useState({ descriptions: [] });
  const [dataLoaded, setDataLoaded] = useState(false);

  // Load data on component mount
  useEffect(() => {
    const loadData = async () => {
      try {
        console.log('Loading enriched data...');
        setLoading(true);
        // Load enriched manifest, search index, and description-classification map
        const [manifestRes, indexRes, classRes] = await Promise.all([
          fetch('./data/enriched-chunks/chunks-manifest.json'),
          fetch('./data/search-index-enriched.json'),
          fetch('./data/description-classification.json')
        ]);
        const [manifest, index, classMap] = await Promise.all([
          manifestRes.json(),
          indexRes.json(),
          classRes.json()
        ]);
        console.log(`Search index: ${index.descriptions.length} descriptions`);
        console.log(`Enriched chunks: ${manifest.numberOfChunks}`);
        setEnrichedManifest(manifest);
        setSearchIndex(index);
        setDescClassMap(classMap || {});

        // Prefetch all enriched chunks on load in parallel and cache them
        const fetchedArrays = await Promise.all(
          (manifest.chunks || []).map(async (ch) => {
            try {
              const cached = chunkCacheRef.current.get(ch.filename);
              if (cached) return cached;
              const resp = await fetch(`./data/enriched-chunks/${ch.filename}`);
              const arr = await resp.json();
              chunkCacheRef.current.set(ch.filename, arr);
              return arr;
            } catch (e) {
              console.error('Failed to load enriched chunk', ch.filename, e);
              return [];
            }
          })
        );
        const all = fetchedArrays.flat();
        setMedicationsData(all);

        setDataLoaded(true);
        setLoading(false);
        
      } catch (error) {
        console.error('Error loading data:', error);
        setLoading(false);
        // Fallback to empty data
        setMedicationsData([]);
        setSearchIndex({ descriptions: [] });
        setDataLoaded(true);
      }
    };

    loadData();
  }, []);

  // Helper function to check if a value is null or empty
  const isNullOrEmpty = (value) => {
    return !value || value === 'NULL' || value === '' || value === null || value === undefined;
  };

  // Helper function to format display values (replace NULL with --)
  const formatDisplayValue = (value) => {
    if (isNullOrEmpty(value)) {
      return '--';
    }
    return value;
  };

  // Best matcher from enriched file's FDA matches
  const getBestMatcherFromEnriched = useCallback((med) => {
    const m = Array.isArray(med.fdaMatches) ? med.fdaMatches : [];
    if (m.length === 0) return null;
    return m[0];
  }, []);

  // No reverse index needed when searching enriched by brand/generic names

  // Fast lookup for description classification to optimize filtering
  const descriptionToClassification = useMemo(() => {
    const map = new Map();
    for (const med of medicationsData) {
      const desc = med && med.ndc_description;
      if (!desc) continue;
      const key = desc.toLowerCase();
      if (!map.has(key) && med.classification_for_rate_setting) {
        map.set(key, med.classification_for_rate_setting);
      }
    }
    return map;
  }, [medicationsData]);

  // Filter suggestions based on search term and drug filter
  const filteredSuggestions = useMemo(() => {
    if (!searchTerm || searchTerm.length < 2 || !dataLoaded) return [];
    
    const term = searchTerm.toLowerCase();
    let suggestions = searchIndex.descriptions
      .filter(desc => desc.toLowerCase().includes(term));
    
    // Apply drug filter
    if (drugFilter === 'branded') {
      // Show only branded drugs (classification_for_rate_setting = 'B')
      suggestions = suggestions.filter(desc => (descClassMap[desc] || '').toUpperCase() === 'B');
    } else if (drugFilter === 'generic') {
      // Show only generic drugs (classification_for_rate_setting = 'G')
      suggestions = suggestions.filter(desc => (descClassMap[desc] || '').toUpperCase() === 'G');
    }
    // If drugFilter === 'all', show all drugs (no additional filtering)
    
    return suggestions.slice(0, 10); // Limit to 10 suggestions
  }, [searchTerm, searchIndex, dataLoaded, drugFilter, descriptionToClassification]);

  useEffect(() => {
    setShowSuggestions(filteredSuggestions.length > 0 && searchTerm.length >= 2);
  }, [filteredSuggestions, searchTerm]);

  // Handle medicine selection
  const handleMedicineSelect = useCallback(async (description) => {
    if (!description) return;
    
    setLoading(true);
    setSearchTerm(description);
    setShowSuggestions(false);
    
    // Load enriched chunks on demand into memory (first selection)
    let dataRef = medicationsData;
    if (enrichedManifest && dataRef.length === 0) {
      const all = [];
      for (const ch of enrichedManifest.chunks) {
        try {
          const cached = chunkCacheRef.current.get(ch.filename);
          if (cached) {
            all.push(...cached);
            continue;
          }
          const resp = await fetch(`./data/enriched-chunks/${ch.filename}`);
          const arr = await resp.json();
          chunkCacheRef.current.set(ch.filename, arr);
          all.push(...arr);
        } catch (e) { console.error('Failed to load enriched chunk', ch.filename, e); }
      }
      setMedicationsData(all);
      dataRef = all;
    }
    // Find all medications with this exact description
    const exactMatches = dataRef.filter(med => med.ndc_description === description);
    
    if (exactMatches.length === 0) {
      setSelectedMedicine(null);
      setMatchedGenerics([]);
      setLoading(false);
      return;
    }

    // Pick the first exact match that has a non-null best FDA matcher; fallback to the first
    const preferred = exactMatches.find(m => Array.isArray(m.fdaMatches) && m.fdaMatches.length > 0) || exactMatches[0];
    const medicine = preferred;
    const bestMatcher = getBestMatcherFromEnriched(medicine);
    const updatedMedicine = {
      ...medicine,
      __bestMatcher: bestMatcher,
      // also set a friendly title source
      fda_nonproprietary_name: (bestMatcher && bestMatcher.genericName) ? bestMatcher.genericName : medicine.fda_nonproprietary_name,
      allMatches: exactMatches
    };
    setSelectedMedicine(updatedMedicine);

    // Search enriched medicaid directly by fdaMatches brand/generic names (case-insensitive substring)
    const searchKeys = new Set();
    if (bestMatcher && bestMatcher.genericName) searchKeys.add(bestMatcher.genericName.toLowerCase());
    if (bestMatcher && bestMatcher.brandName) searchKeys.add(bestMatcher.brandName.toLowerCase());
    const out = [];
    const seen = new Set();
    for (const r of medicationsData) {
      const ms = Array.isArray(r.fdaMatches) ? r.fdaMatches : [];
      if (!ms.length) continue;
      let ok = false;
      for (const m of ms) {
        const bn = (m.brandName || '').toLowerCase();
        const gn = (m.genericName || '').toLowerCase();
        for (const k of searchKeys) {
          if (!k) continue;
          if ((bn && bn.includes(k)) || (gn && gn.includes(k))) { ok = true; break; }
        }
        if (ok) break;
      }
      if (!ok) continue;
      const key = `${r.ndc}|${r.ndc_description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    // Exclude branded drugs from generic listing (classification_for_rate_setting === 'B')
    let genericsOnly = out.filter(r => (r.classification_for_rate_setting || '').toUpperCase() !== 'B');

    // Exclude the currently selected medicine using the same de-dup key (description + price + labeler)
    const resolveLabeler = (rec) => {
      const fm = Array.isArray(rec.fdaMatches) ? rec.fdaMatches : [];
      const best = fm.length > 0 ? fm[0] : null;
      return (rec.fda_labeler_name || rec.__matchLabelerName || (best && best.labelerName) || '').toString().trim();
    };
    const selectedLabeler = (updatedMedicine.fda_labeler_name || updatedMedicine.__matchLabelerName || (bestMatcher && bestMatcher.labelerName) || '').toString().trim();
    const selectedPrice = (updatedMedicine.nadac_per_unit || '').toString().trim();
    const selectedDesc = (updatedMedicine.ndc_description || '').toString().trim();
    const selectedKey = `${selectedDesc.toLowerCase()}|${selectedPrice}|${selectedLabeler.toLowerCase()}`;
    genericsOnly = genericsOnly.filter(rec => {
      const labeler = resolveLabeler(rec);
      const price = (rec.nadac_per_unit || '').toString().trim();
      const desc = (rec.ndc_description || '').toString().trim();
      const key = `${desc.toLowerCase()}|${price}|${labeler.toLowerCase()}`;
      return key !== selectedKey;
    });
    // Make list unique by description + price + labeler
    const seenKeySet = new Set();
    const unique = [];
    for (const r of genericsOnly) {
      const fm = Array.isArray(r.fdaMatches) ? r.fdaMatches : [];
      const best = fm.length > 0 ? fm[0] : null;
      const labeler = (r.fda_labeler_name || r.__matchLabelerName || (best && best.labelerName) || '').toString().trim();
      const price = (r.nadac_per_unit || '').toString().trim();
      const desc = (r.ndc_description || '').toString().trim();
      const key = `${desc.toLowerCase()}|${price}|${labeler.toLowerCase()}`;
      if (seenKeySet.has(key)) continue;
      seenKeySet.add(key);
      unique.push(r);
    }
    // Relevancy sorting by dosage strength difference
    const parseNumbers = (s) => {
      const str = (s || '').toString();
      const m = str.match(/\d+(?:\.\d+)?/g);
      return m ? m.map(v => parseFloat(v)).filter(n => Number.isFinite(n)) : [];
    };
    const sumNumbers = (arr) => arr.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
    const sumFromMatcher = (m) => {
      if (!m) return 0;
      let nums = [];
      if (Array.isArray(m.activeIngredientsDetailed)) {
        for (const ai of m.activeIngredientsDetailed) {
          nums = nums.concat(parseNumbers(ai && ai.strength));
        }
      }
      if (nums.length === 0 && m.dosageStrength) nums = parseNumbers(m.dosageStrength);
      return sumNumbers(nums);
    };
    const sumFromRecord = (r) => {
      const fm = Array.isArray(r.fdaMatches) ? r.fdaMatches : [];
      if (fm.length > 0) return sumFromMatcher(fm[0]);
      return sumNumbers(parseNumbers(r.ndc_description));
    };
    const baseSum = bestMatcher ? sumFromMatcher(bestMatcher) : sumNumbers(parseNumbers(updatedMedicine.ndc_description));
    const scored = unique.map(r => ({ rec: r, diff: Math.abs(sumFromRecord(r) - baseSum) }));
    scored.sort((a, b) => a.diff - b.diff);
    console.log(`Found ${out.length} matches; showing ${unique.length} unique generics after filtering, excluding selected, de-dup, and sorting by dosage diff`);
    setMatchedGenerics(scored.map(s => s.rec));

    setLoading(false);
  }, [medicationsData, getBestMatcherFromEnriched]);

  const handleSearch = () => {
    if (!searchTerm.trim() || !dataLoaded) return;
    
    // Use the sophisticated handleMedicineSelect logic
    handleMedicineSelect(searchTerm);
  };



  const handleSuggestionClick = (suggestion) => {
    setSearchTerm(suggestion);
    setShowSuggestions(false);
    // Use the sophisticated handleMedicineSelect logic
    setTimeout(() => {
      handleMedicineSelect(suggestion);
    }, 100);
  };

  const formatPrice = (price) => {
    if (isNullOrEmpty(price)) return '--';
    return `$${parseFloat(price).toFixed(5)}`;
  };

  const formatStrength = (strength, unit) => {
    if (isNullOrEmpty(strength) && isNullOrEmpty(unit)) return '--';
    return `${formatDisplayValue(strength)} ${formatDisplayValue(unit)}`.trim();
  };

  // Show loading state while data is being loaded
  if (!dataLoaded) {
    return (
      <div className="App">
        <header className="app-header">
          <h1>🏥 Medicine Search - NADAC Database</h1>
          <p>Loading medication data...</p>
        </header>
        <main className="main-content">
          <div className="loading-state">
            <h2>⏳ Loading Data...</h2>
            <p>Please wait while we load the medication database.</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="app-header">
        <h1>🏥 Medicine Search - NADAC Database</h1>
        <p>Search for medications and find generic alternatives with pricing information</p>
        <p><small>Database loaded: {medicationsData.length} medications available</small></p>
      </header>

      <main className="main-content">
        {/* Search Section */}
        <div className="search-section">
          <h2>🔍 Search Medicine</h2>
          
          {/* Filter Controls */}
          <div className="search-filter-controls">
            <div className="three-way-switch">
              <button
                className={`switch-option ${drugFilter === 'branded' ? 'active' : ''}`}
                onClick={() => setDrugFilter('branded')}
              >
                Branded Drugs
              </button>
              <button
                className={`switch-option ${drugFilter === 'generic' ? 'active' : ''}`}
                onClick={() => setDrugFilter('generic')}
              >
                Generic Drugs
              </button>
              <button
                className={`switch-option ${drugFilter === 'all' ? 'active' : ''}`}
                onClick={() => setDrugFilter('all')}
              >
                All Drugs
              </button>
            </div>
          </div>
          
          <div className="search-container">
            <div className="search-input-container">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Type medicine name (e.g., ACETAMINOPHEN 500 MG TABLET)"
                className="search-input"
                onFocus={() => setShowSuggestions(filteredSuggestions.length > 0)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button 
                onClick={handleSearch} 
                className="search-button"
                disabled={loading || !dataLoaded}
              >
                {loading ? '⏳' : '🔍'} Search
              </button>
            </div>
            
            {/* Suggestions Dropdown */}
            {showSuggestions && (
              <div className="suggestions-dropdown">
                {filteredSuggestions.map((suggestion, index) => (
                  <div 
                    key={index}
                    className="suggestion-item"
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Selected Medicine Details */}
        {selectedMedicine ? (
          <div className="medicine-details">
            <h2>💊 Selected Medicine Details</h2>
            <div className="details-card">
              <div className="detail-section">
                <h3>Basic Information</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <label>Drug Description:</label>
                    <span>{formatDisplayValue(selectedMedicine.ndc_description)}</span>
                  </div>
                  <div className="detail-item">
                    <label>NDC:</label>
                    <span>{formatDisplayValue(selectedMedicine.ndc)}</span>
                  </div>
                  <div className="detail-item">
                    <label>NADAC Per Unit:</label>
                    <span className="price">{formatPrice(selectedMedicine.nadac_per_unit)}</span>
                  </div>
                  <div className="detail-item">
                    <label>Pricing Unit:</label>
                    <span>{formatDisplayValue(selectedMedicine.pricing_unit)}</span>
                  </div>
                  <div className="detail-item">
                    <label>Classification:</label>
                    <span className={`classification ${selectedMedicine.classification_for_rate_setting}`}>
                      {selectedMedicine.classification_for_rate_setting === 'G' ? 'Generic' : 'Brand'}
                    </span>
                  </div>
                  <div className="detail-item">
                    <label>OTC:</label>
                    <span>{formatDisplayValue(selectedMedicine.otc)}</span>
                  </div>
                </div>
              </div>

              {selectedMedicine.__bestMatcher ? (
                <div className="detail-section">
                  <h3>FDA Information</h3>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <label>Generic Name:</label>
                      <span>{formatDisplayValue(selectedMedicine.__bestMatcher.genericName)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Brand Name:</label>
                      <span>{formatDisplayValue(selectedMedicine.__bestMatcher.brandName)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Dosage Form:</label>
                      <span>{formatDisplayValue(selectedMedicine.__bestMatcher.dosageForm)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Route:</label>
                      <span>{formatDisplayValue((selectedMedicine.__bestMatcher.routes || []).join(', '))}</span>
                    </div>
                    <div className="detail-item">
                      <label>Labeler:</label>
                      <span>{formatDisplayValue(selectedMedicine.__bestMatcher.labelerName)}</span>
                    </div>
                    <div className="detail-item">
                      <label>Active Ingredients:</label>
                      <span>{formatDisplayValue((selectedMedicine.__bestMatcher.activeIngredientsDetailed || []).map(ai => {
                        const n = ai.name || '';
                        const s = ai.strength || '';
                        return (n && s) ? `${n} ${s}` : (n || s);
                      }).filter(Boolean).join('; '))}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="no-fda-info">
                  <h3>❌ No FDA Information Available</h3>
                  <p>No detailed FDA information available for this medication.</p>
                </div>
              )}
            </div>
          </div>
        ) : searchTerm && !loading ? (
          <div className="no-results">
            <h2>❌ No Results Found</h2>
            <p>No medication found matching "{searchTerm}". Please check the spelling or try a different search term.</p>
          </div>
        ) : null}

        {/* Matched Generic Drugs Section */}
        {matchedGenerics.length > 0 && selectedMedicine && (
          <div className="generic-drugs-section">
            <h2>🧬 Matching Generic Options</h2>
            <p>Found {matchedGenerics.length} generic options for <strong>{selectedMedicine.fda_nonproprietary_name}</strong></p>
            
            <div className="generic-drugs-grid">
              {matchedGenerics.slice(0, 50).map((drug, index) => (
                <div key={index} className="generic-drug-card">
                  <div className="drug-name">{drug.ndc_description}</div>
                  <div className="drug-details">
                    <div className="price-info">
                      <span className="price">{formatPrice(drug.nadac_per_unit)}</span>
                      <span className="unit">per {drug.pricing_unit}</span>
                    </div>
{/*                     {Array.isArray(drug.__matchSources) && drug.__matchSources.length > 0 && (
                      <div className="match-badges">
                        <small>Matched by: {drug.__matchSources.map((s, i) => `${s.source}:${s.generic}`).join(', ')}</small>
                      </div>
                    )} */}
                    <div className="classification">
                      <span className={`classification ${drug.classification_for_rate_setting}`}>
                        {drug.classification_for_rate_setting === 'G' ? 'Generic' : 'Brand'}
                      </span>
                    </div>
                    {(() => {
                      const fm = Array.isArray(drug.fdaMatches) ? drug.fdaMatches : [];
                      const best = fm.length > 0 ? fm[0] : null;
                      const labeler = drug.fda_labeler_name || drug.__matchLabelerName || (best && best.labelerName) || '';
                      return !isNullOrEmpty(labeler) ? (
                      <div className="labeler-name">
                          <strong>Labeler:</strong> {formatDisplayValue(labeler)}
                      </div>
                      ) : null;
                    })()}
                    {!isNullOrEmpty(drug.fda_active_numerator_strength) && (
                      <div className="strength-info">
                        <strong>Strength:</strong> {formatStrength(drug.fda_active_numerator_strength, drug.fda_active_ingred_unit)}
                      </div>
                    )}
                    <div className="ndc">
                      <strong>NDC:</strong> {formatDisplayValue(drug.ndc)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            
            {matchedGenerics.length > 50 && (
              <p className="showing-limited">Showing first 50 of {matchedGenerics.length} results</p>
            )}
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>Medicine Search App - NADAC Database | Data as of latest update</p>
      </footer>
    </div>
  );
}

export default App; 